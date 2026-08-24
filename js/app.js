/* ============================================================
 * app.js  —  设计需求发布平台 主逻辑
 * 登录/注册 · 需求大厅 · 我发布的 · 我抢的 · 发布 · 抢单 · 实时聊天
 * ============================================================ */
(function () {
  const $ = (s) => document.querySelector(s);
  const APPV = 'v31';

  // ---------- PWA 安装引导（尽早监听，浏览器触发 beforeinstallprompt 即提示） ----------
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    showInstallBanner();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    hideInstallBanner();
  });
  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  }
  function showInstallBanner() {
    if (isStandalone()) return;
    const b = $('#installBanner'); if (b) b.style.display = 'flex';
  }
  function hideInstallBanner() {
    const b = $('#installBanner'); if (b) b.style.display = 'none';
  }

  const state = {
    uid: null,
    name: '',
    tab: 'board',
    boardKeyword: '',
    boardFilter: '全部',   // 类型
    boardStatus: 'open',   // 状态筛选
    boardSort: 'newest',   // 排序
    boardLimit: 30,        // 分页每页条数
    boardOffset: 0,        // 当前已加载条数
    boardTotal: 0,         // 匹配总数
    boardBusy: false,      // 防止重复加载
    boardCh: null,         // 大厅实时订阅
    chatCh: null,          // 当前聊天订阅
    chatReq: null,
    chatFiles: [],         // 当前聊天待发送附件
    publishFiles: [],      // 发布表单待上传参考图
    chats: [],             // Inbox 会话列表缓存
    unreadTotal: 0,
    isAdmin: false         // 是否为平台管理员（工作台 designers.is_admin）
  };

  // ---------- 工具 ----------
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.style.display = 'none'; }, 2200);
  }
  function esc(s) {
    return (s || '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts), n = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const sameDay = d.toDateString() === n.toDateString();
    return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
  }
  // 倒计时：返回 { html, overdue }；deadline=null 返回空
  function countdownHtml(deadline) {
    if (!deadline) return '';
    const diff = new Date(deadline).getTime() - Date.now();
    if (diff <= 0) return `<span class="req-urgency overdue">已超时</span>`;
    const h = Math.floor(diff / 3600000);
    let cls = '', txt = '';
    if (h < 24) { cls = 'urgent'; txt = `剩 ${h}小时`; }
    else if (h < 72) { cls = 'soon'; txt = `剩 ${Math.floor(h/24)}天`; }
    else { cls = ''; txt = `${Math.floor(h/24)}天后截止`; }
    return `<span class="req-urgency ${cls}">⏰ ${txt}</span>`;
  }
  function initials(name) {
    if (!name) return '?';
    const s = String(name).trim();
    return s.charAt(0).toUpperCase();
  }
  // 判断当前用户是否有权看到发布者真实信息：
  //  - 自己发布 → 可见
  //  - 已抢单(非 open) → 锁定设计师/管理员可见
  //  - 未抢单且 hide_publisher=true → 仅自己/管理员可见，其余匿名
  function canSeePublisher(r) {
    if (!r) return true;
    if (r.publisher_id === state.uid) return true;
    if (state.isAdmin) return true;
    if (r.status === 'open' && r.hide_publisher) return false;
    if (r.status !== 'open' && r.locked_by === state.uid) return true;
    return !r.hide_publisher;   // 未隐藏或可公开
  }
  function visiblePublisherName(r) {
    return canSeePublisher(r) ? (r.publisher_name || '匿名') : '匿名发布者';
  }
  function statusBadge(st) {
    const s = Cfg.STATUS[st] || { label: st, color: '#64748b' };
    return `<span class="badge" style="background:${s.color}">${s.label}</span>`;
  }

  // ---------- 屏幕切换 ----------
  function hideSplash() { $('#bootSplash').classList.add('hide'); }
  function showAuth() {
    $('#authScreen').style.display = 'flex';
    $('#app').style.display = 'none';
  }
  function showApp() {
    $('#authScreen').style.display = 'none';
    $('#app').style.display = 'flex';
  }

  // ---------- 启动 ----------
  async function boot() {
    // 【v540】跨产品快速登录：workbench 跳转时会把 access_token/refresh_token 拼到 URL hash
    // 启动时优先检测，命中则 setSession() 让 Supabase 接管，再立即清掉 hash 防泄露
    await maybeAdoptSessionFromHash();
    const { data } = await DB.getSession();
    if (data && data.session) {
      await enterApp(data.session.user);
    } else {
      hideSplash();
      showAuth();
    }
  }

  // 从 URL hash 接收 workbench 传来的 session token。失败静默回退到登录页，不抛错打断启动。
  async function maybeAdoptSessionFromHash() {
    const h = location.hash || '';
    if (!/access_token=/.test(h)) return;
    const params = new URLSearchParams(h.slice(1));
    const at = params.get('access_token');
    const rt = params.get('refresh_token');
    if (!at) { clearHash(); return; }
    try {
      const { error } = await DB.setSession(at, rt);
      if (error) console.warn('跨产品快速登录 setSession 失败：', error);
    } catch (e) {
      console.warn('跨产品快速登录异常，回退到登录页：', e);
    }
    clearHash();
  }
  function clearHash() {
    // 用 replaceState 不留浏览器历史，避免 hash（含 token）残留在后退/前进栈
    try { history.replaceState(null, '', location.pathname + location.search); }
    catch (e) { location.hash = ''; }
  }

  async function enterApp(user) {
    state.uid = user.id;
    state.name = await DB.myDisplayName();
    state.isAdmin = await DB.isAdmin(user.id).catch(() => false);
    $('#userName').textContent = state.name + (state.isAdmin ? ' 👑' : '');
    $('#userAvatar').textContent = initials(state.name);
    hideSplash();
    showApp();
    // 大厅实时订阅（全员可见的锁定/状态变化）
    if (state.boardCh) DB.unsubscribe(state.boardCh);
    state.boardCh = DB.subscribeBoard(() => {
      if (state.tab === 'board') doBoardRefresh();
      else if (state.tab === 'mine') renderMine();
      else if (state.tab === 'grabbed') renderGrabbed();
      refreshInbox();
    });
    // 消息实时订阅（仅我参与的会话消息会被服务端 RLS 推过来）
    if (state.inboxCh) DB.unsubscribe(state.inboxCh);
    state.inboxCh = DB.subscribeAllMessages((row) => {
      refreshInbox();
      // 未读悬浮提示：收到别人/系统消息，且当前没开着对应聊天窗
      const isMine = row.sender_id === state.uid;
      const isSystem = row.msg_type === 'system';
      if (!isMine) {
        const chatOpen = state.chatReq && state.chatReq.id === row.requirement_id
          && $('#chatMask') && $('#chatMask').style.display === 'flex';
        if (!chatOpen) showMsgToast(row);
      }
    });
    refreshInbox();
    switchTab('board');
    // 【v29】跨产品深链：URL 带 ?req=<需求id> 时，登录后自动打开该需求详情抽屉
    try {
      const deepReq = new URLSearchParams(location.search).get('req');
      if (deepReq) {
        history.replaceState(null, '', location.pathname);   // 清掉 query，避免刷新重复打开
        openDetail(deepReq);
      }
    } catch (e) { /* 深链失败静默 */ }
  }

  // ---------- 认证 ----------
  let authMode = 'login';
  // 记住账号密码：localStorage 存 {id, pwd(base64 混淆), remember}
  // ⚠️ base64 只是防明文，不是加密；内部平台够用，更稳妥可交给浏览器自动填充
  function saveAuthRemember(id, pwd) {
    if (!$('#authRemember').checked) { localStorage.removeItem('dr_auth_remember'); return; }
    localStorage.setItem('dr_auth_remember', JSON.stringify({ id, pwd: btoa(pwd), remember: true }));
  }
  function prefillAuth() {
    try {
      const s = JSON.parse(localStorage.getItem('dr_auth_remember') || 'null');
      if (s && s.id) {
        $('#authEmail').value = s.id;
        $('#authRemember').checked = true;
        if (s.pwd) $('#authPwd').value = atob(s.pwd);
      }
    } catch (e) { /* 忽略损坏数据 */ }
  }
  function bindAuth() {
    document.querySelectorAll('.seg-btn').forEach(b => b.addEventListener('click', () => {
      authMode = b.dataset.mode;
      document.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('active', x === b));
      $('#authSubmit').textContent = authMode === 'login' ? '登录' : '注册并进入';
      $('#authHint').textContent = '';
      const rn = $('#authRealName');
      if (rn) {
        rn.style.display = authMode === 'register' ? 'block' : 'none';
        if (authMode === 'login') rn.value = '';
      }
    }));
    // 显示/隐藏密码
    $('#authPwdToggle').addEventListener('click', () => {
      const inp = $('#authPwd');
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      $('#authPwdToggle').textContent = show ? '🙈' : '👁';
    });
    // 回车提交（中文输入法组词时不触发）
    ['authEmail', 'authPwd', 'authRealName'].forEach(id => {
      const el = $('#' + id);
      if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) $('#authSubmit').click(); });
    });
    prefillAuth();
    $('#authSubmit').addEventListener('click', async () => {
      const email = $('#authEmail').value.trim();
      const pwd = $('#authPwd').value;
      const realName = $('#authRealName').value.trim();
      if (!email || pwd.length < 6) { $('#authHint').textContent = '请输入邮箱与≥6位密码'; return; }
      if (authMode === 'register' && !realName) { $('#authHint').textContent = '请输入真实姓名'; return; }
      $('#authHint').textContent = '处理中…';
      try {
        if (authMode === 'login') {
          const { error } = await DB.signIn(email, pwd);
          if (error) throw error;
          saveAuthRemember(email, pwd);
          // onAuthStateChange 会触发 enterApp
        } else {
          const { data, error } = await DB.signUp(email, pwd);
          if (error) throw error;
          saveAuthRemember(email, pwd);
          if (data.session) {
            // 关了邮箱验证：直接登录；把真实姓名写入 designers 展示名
            try { await DB.updateDisplayName(data.user.id, realName); } catch (e) { console.warn('保存真实姓名失败', e); }
          } else {
            $('#authHint').textContent = '注册成功，请查收验证邮件后登录';
            authMode = 'login';
            document.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('active', x.dataset.mode === 'login'));
            $('#authSubmit').textContent = '登录';
            const rn = $('#authRealName');
            if (rn) { rn.style.display = 'none'; rn.value = ''; }
            return;
          }
        }
        $('#authHint').textContent = '';
      } catch (e) {
        $('#authHint').textContent = (e.message || '操作失败');
      }
    });
  }

  // ---------- Tab ----------
  async function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    const titleMap = { board: '需求大厅', mine: '我发布的', grabbed: '我抢的', coupons: '我的券包', publish: '发布需求' };
    $('.topbar-title').textContent = titleMap[tab] || '需求大厅';
    const fab = $('#fabPublish');
    if (fab) fab.classList.toggle('hide-fab', tab === 'publish');
    if (tab === 'board') renderBoard();
    else if (tab === 'mine') renderMine();
    else if (tab === 'grabbed') renderGrabbed();
    else if (tab === 'coupons') renderCoupons();
    else if (tab === 'publish') renderPublish();
  }
  function bindTabs() {
    document.querySelectorAll('.tab-btn').forEach(b =>
      b.addEventListener('click', () => switchTab(b.dataset.tab)));
    $('#btnSignOut').addEventListener('click', async () => {
      if (state.boardCh) DB.unsubscribe(state.boardCh);
      if (state.chatCh) DB.unsubscribe(state.chatCh);
      if (state.inboxCh) DB.unsubscribe(state.inboxCh);
      await DB.signOut();
      location.reload();
    });
    $('#btnInbox').addEventListener('click', openInbox);
    const fab = $('#fabPublish');
    if (fab) fab.addEventListener('click', () => switchTab('publish'));
    // PWA 安装按钮
    $('#installBtn').addEventListener('click', async () => {
      if (!deferredPrompt) { hideInstallBanner(); return; }
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      hideInstallBanner();
    });
    $('#installClose').addEventListener('click', hideInstallBanner);
    $('#inboxClose').addEventListener('click', closeInbox);
    $('#detailClose').addEventListener('click', closeDetail);
    // 点遮罩关闭
    $('#inboxMask').addEventListener('click', (e) => { if (e.target.id === 'inboxMask') closeInbox(); });
    $('#detailMask').addEventListener('click', (e) => { if (e.target.id === 'detailMask') closeDetail(); });
  }

  // ---------- 渲染：大厅 ----------
  async function renderBoard() {
    const el = $('#tabContent');
    const { boardKeyword: kw, boardFilter: type, boardStatus, boardSort } = state;
    const typeChips = ['全部', ...Cfg.TASK_TYPES].map(t =>
      `<button class="chip ${type === t ? 'active' : ''}" data-type="${esc(t)}">${esc(t)}</button>`).join('');
    const statusOpts = [
      ['open', '可抢'], ['locked', '已抢'], ['in_progress', '设计中'],
      ['cancel_request', '取消待确认'], ['done', '已完成'], ['cancelled', '已取消'], ['all', '全部状态']
    ].map(([v, l]) => `<option value="${v}" ${boardStatus === v ? 'selected' : ''}>${l}</option>`).join('');
    const sortOpts = [
      ['newest', '最新发布'], ['deadline', '最近截止'],
      ['budget_high', '金额高→低'], ['budget_low', '金额低→高']
    ].map(([v, l]) => `<option value="${v}" ${boardSort === v ? 'selected' : ''}>${l}</option>`).join('');
    el.innerHTML = `<div class="filter-bar">
      <div class="stats-row">
        <div class="stat-card" data-stat="open"><div class="stat-label">可抢单</div><div class="stat-num" id="statOpen">–</div></div>
        <div class="stat-card" data-stat="mine"><div class="stat-label">我发布</div><div class="stat-num" id="statMine">–</div></div>
        <div class="stat-card" data-stat="progress"><div class="stat-label">进行中</div><div class="stat-num" id="statProgress">–</div></div>
      </div>
      <div class="search-row">
        <input id="boardSearch" placeholder="搜索标题或描述关键字…" value="${esc(kw)}" />
      </div>
      <div class="chip-row" id="boardTypeChips">${typeChips}</div>
      <div class="filter-row cols-2">
        <select id="boardStatus">${statusOpts}</select>
        <select id="boardSort">${sortOpts}</select>
      </div>
    </div><div id="boardList"></div><div id="boardMore" class="load-more-wrap" style="display:none"><button id="boardMoreBtn" class="btn load-more">加载更多</button></div>`;

    let kwTimer = null;
    $('#boardSearch').addEventListener('input', (e) => {
      state.boardKeyword = e.target.value;
      clearTimeout(kwTimer);
      kwTimer = setTimeout(doBoardRefresh, 300); // 防抖：避免每敲一个字都打 Supabase
    });
    $('#boardStatus').addEventListener('change', (e) => { state.boardStatus = e.target.value; doBoardRefresh(); });
    $('#boardSort').addEventListener('change', (e) => { state.boardSort = e.target.value; doBoardRefresh(); });
    $('#boardTypeChips').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-type]'); if (!chip) return;
      state.boardFilter = chip.dataset.type;
      $('#boardTypeChips').querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === chip));
      doBoardRefresh();
    });
    document.querySelectorAll('.stat-card').forEach(card => {
      card.addEventListener('click', () => {
        const s = card.dataset.stat;
        if (s === 'mine') { switchTab('mine'); return; }
        state.boardStatus = s === 'progress' ? 'in_progress' : 'open';
        const sel = $('#boardStatus'); if (sel) sel.value = state.boardStatus;
        doBoardRefresh();
      });
    });
    const moreBtn = $('#boardMoreBtn');
    if (moreBtn) moreBtn.addEventListener('click', loadMore);

    await refreshBoardStats();
    await loadBoardList();
  }
  // 大厅顶部统计（失败不阻塞列表）
  async function refreshBoardStats() {
    try {
      const s = await DB.getBoardStats(state.uid);
      const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
      set('#statOpen', s.open); set('#statMine', s.mine); set('#statProgress', s.progress);
    } catch (e) { /* 忽略 */ }
  }
  // 仅重拉列表（输入搜索词时不重建搜索栏，保留焦点）
  let _boardReqToken = 0;
  async function doBoardRefresh() {
    const token = ++_boardReqToken;
    state.boardOffset = 0;
    const box = $('#boardList'); if (!box) return;
    box.innerHTML = skeletonHtml(2);
    refreshBoardStats();
    let res;
    try {
      res = await DB.listBoard({
        keyword: state.boardKeyword, type: state.boardFilter,
        status: state.boardStatus, sort: state.boardSort,
        limit: state.boardLimit, offset: 0
      });
    } catch (e) {
      if (token !== _boardReqToken) return;
      box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return;
    }
    if (token !== _boardReqToken) return;
    state.boardTotal = res.total;
    state.boardOffset = res.list.length;
    renderReqList(res.list, box, 'board', '没有找到匹配的需求');
    updateBoardMore();
  }
  async function loadBoardList() {
    const box = $('#boardList'); if (!box) return;
    state.boardOffset = 0;
    box.innerHTML = skeletonHtml(3);
    let res;
    try {
      res = await DB.listBoard({
        keyword: state.boardKeyword, type: state.boardFilter,
        status: state.boardStatus, sort: state.boardSort,
        limit: state.boardLimit, offset: 0
      });
    } catch (e) {
      box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return;
    }
    state.boardTotal = res.total;
    state.boardOffset = res.list.length;
    renderReqList(res.list, box, 'board', '没有找到匹配的需求');
    updateBoardMore();
  }
  // 更新"加载更多"按钮：全部加载完或不足一页时隐藏
  function updateBoardMore() {
    const wrap = $('#boardMore');
    if (!wrap) return;
    wrap.style.display = (state.boardOffset < state.boardTotal) ? 'block' : 'none';
  }
  // 加载下一页并追加卡片（防重入）
  async function loadMore() {
    if (state.boardBusy) return;
    state.boardBusy = true;
    const btn = $('#boardMoreBtn'); if (btn) btn.textContent = '加载中…';
    try {
      const res = await DB.listBoard({
        keyword: state.boardKeyword, type: state.boardFilter,
        status: state.boardStatus, sort: state.boardSort,
        limit: state.boardLimit, offset: state.boardOffset
      });
      const box = $('#boardList'); if (!box) return;
      appendReqList(res.list, box, 'board');
      state.boardTotal = res.total;
      state.boardOffset += res.list.length;
      updateBoardMore();
    } catch (e) {
      toast('加载失败：' + (e.message || e));
    } finally {
      state.boardBusy = false;
      if (btn) btn.textContent = '加载更多';
    }
  }

  // ---------- 渲染：我发布的 ----------
  async function renderMine() {
    const el = $('#tabContent');
    el.innerHTML = `<div id="mineList">${skeletonHtml(2)}</div>`;
    let list;
    try { list = await DB.listMine(state.uid); }
    catch (e) { el.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
    if (!list.length) { el.innerHTML = emptyHtml('还没有发布需求，去「发布」试试'); return; }
    renderReqList(list, $('#mineList'), 'mine');
  }

  // ---------- 渲染：我抢的 ----------
  async function renderGrabbed() {
    const el = $('#tabContent');
    el.innerHTML = `<div id="grabbedList">${skeletonHtml(2)}</div>`;
    let list;
    try { list = await DB.listGrabbed(state.uid); }
    catch (e) { el.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
    if (!list.length) { el.innerHTML = emptyHtml('还没抢到单，去「大厅」看看'); return; }
    renderReqList(list, $('#grabbedList'), 'grabbed');
  }

  // ---------- 渲染：我的券包 ----------
  function couponStatusTag(c) {
    const now = Date.now();
    const expired = c.expire_at && new Date(c.expire_at).getTime() < now;
    if (c.used_at) return `<span class="cp-tag used">已使用</span>`;
    if (expired)   return `<span class="cp-tag expired">已过期</span>`;
    return `<span class="cp-tag active">可用</span>`;
  }

  // 优惠券大字面值展示
  function couponValueBig(c) {
    if (c.type === 'cash') return `<div class="cp-big val-cash"><small>¥</small>${Number(c.value).toFixed(0)}</div>`;
    if (c.type === 'member_half') return `<div class="cp-big val-half">半价</div>`;
    const zhe = Number(c.value * 10).toFixed(Number.isInteger(c.value * 10) ? 0 : 1);
    return `<div class="cp-big val-percent"><span class="num">${zhe}</span><span class="unit">折</span></div>`;
  }

  // 通用优惠券卡片（mine=我的券包，admin=管理员面板）
  function couponCardHtml(c, ctx) {
    const isUsed = !!c.used_at;
    const isPaused = !c.active && !isUsed;
    const expired = c.expire_at && new Date(c.expire_at).getTime() < Date.now();
    const cls = ['cp-ticket', `type-${c.type}`, isUsed ? 'is-used' : '', isPaused ? 'is-paused' : '', expired ? 'is-expired' : ''].filter(Boolean).join(' ');
    const scope = c.owner_id ? '专属券' : '公开活动码';
    const statusTag = ctx === 'admin'
      ? (isUsed ? '<span class="cp-tag used">已核销</span>' : (c.active ? '<span class="cp-tag active">启用</span>' : '<span class="cp-tag expired">停用</span>'))
      : couponStatusTag(c);
    const typeName = c.type === 'cash' ? '抵现券' : (c.type === 'member_half' ? '会员半价券' : '折扣券');
    const exclusiveBadge = c.owner_id ? '<span class="cp-exclusive">专属</span>' : '';
    const title = c.campaign || typeName;
    const ops = ctx === 'admin' ? `
      <div class="cp-admin-ft">
        <button class="btn btn-xs" data-edit="${c.id}">编辑</button>
        ${isUsed ? '<span class="cp-admin-tip">已核销不可删除</span>' : `<button class="btn btn-xs btn-ghost" data-del="${c.id}">删除</button>`}
      </div>` : '';
    return `<div class="${cls}">
      <div class="cp-left">${couponValueBig(c)}</div>
      <div class="cp-divider"></div>
      <div class="cp-right">
        <div class="cp-title">${esc(title)}</div>
        <div class="cp-sub">${Number(c.min_amount) > 0 ? `满 ¥${Number(c.min_amount).toFixed(0)} 可用` : '无门槛'}</div>
        <div class="cp-meta">
          <span class="cp-code">${esc(c.code)}${exclusiveBadge}</span>
          ${statusTag}
        </div>
        ${c.expire_at ? `<div class="cp-exp">有效期至 ${fmtTime(c.expire_at)} · ${esc(scope)}</div>` : `<div class="cp-exp">永久有效 · ${esc(scope)}</div>`}
        ${ops}
      </div>
    </div>`;
  }

  async function renderCoupons() {
    const el = $('#tabContent');
    el.innerHTML = `<div class="coupon-pack">
      <div id="myCoupons" class="skeleton-list">${skeletonHtml(2)}</div>
      ${state.isAdmin ? `<div class="admin-coupon">
        <div class="admin-coupon-hd">
          <span>⚙️ 自动发放规则（注册送 / 定期送，管理员配置）</span>
          <button id="btnNewRule" class="btn btn-sm btn-primary">+ 新建规则</button>
        </div>
        <div id="adminRuleList" class="admin-coupon-body"></div>
      </div>` : ''}
      ${state.isAdmin ? `<div class="admin-coupon">
        <div class="admin-coupon-hd">
          <span>👑 手动发券 / 配置优惠券</span>
          <button id="btnNewCoupon" class="btn btn-sm btn-primary">+ 新建优惠券</button>
        </div>
        <div id="adminCouponList" class="admin-coupon-body"></div>
      </div>` : ''}
    </div>`;

    // 我的券（含已用/过期，前端分类状态）
    try {
      const list = await DB.listMyCoupons(state.uid);
      const box = $('#myCoupons');
      if (!list.length) {
        box.className = 'empty-box';
        box.innerHTML = `<div class="empty">还没有券。注册会员自动获赠券（规则由管理员配置），活动码可在发布页填写。</div>`;
      } else {
        box.className = 'cp-grid';
        box.innerHTML = list.map(c => couponCardHtml(c, 'mine')).join('');
      }
    } catch (e) {
      $('#myCoupons').innerHTML = `<div class="empty">券加载失败：${esc(e.message)}</div>`;
    }

    // 管理员面板
    if (state.isAdmin) {
      const btnR = $('#btnNewRule');
      if (btnR) btnR.addEventListener('click', () => openRuleEditor(null));
      const btn = $('#btnNewCoupon');
      btn.addEventListener('click', () => openCouponEditor(null));
      loadAdminRules();
      loadAdminCoupons();
    }
  }

  // 管理员：加载全部券
  async function loadAdminCoupons() {
    const box = $('#adminCouponList');
    if (!box) return;
    box.innerHTML = '<div class="empty">加载中…</div>';
    try {
      const res = await DB.adminListCoupons(state.uid);
      console.log('[admin] list res', res);
      if (!res || !res.ok) {
        box.innerHTML = `<div class="empty">${esc(res && res.msg ? res.msg : '加载失败')}<br><button id="btnRetryAdmin" class="btn btn-sm">重试</button></div>`;
        $('#btnRetryAdmin')?.addEventListener('click', loadAdminCoupons);
        return;
      }
      const rows = res.rows || [];
      if (!rows.length) {
        box.innerHTML = `<div class="empty-box admin-empty"><div class="empty-emoji">🎫</div><div>暂无优惠券</div><div class="empty-sub">点击右上角「+ 新建优惠券」开始发券</div></div>`;
        return;
      }
      box.innerHTML = `<div class="cp-admin-grid">${rows.map(r => adminCouponCard(r)).join('')}</div>`;
      box.querySelectorAll('[data-edit]').forEach(b =>
        b.addEventListener('click', () => openCouponEditor(b.dataset.edit)));
      box.querySelectorAll('[data-del]').forEach(b =>
        b.addEventListener('click', async () => {
          if (!confirm('确认删除该优惠券？')) return;
          const d = await DB.adminDeleteCoupon(state.uid, b.dataset.del).catch(e => ({ ok: false, msg: e.message }));
          toast(d.ok ? '已删除' : ('删除失败：' + (d.msg || '')));
          if (d.ok) loadAdminCoupons();
        }));
    } catch (e) {
      console.error('[admin] load error', e);
      box.innerHTML = `<div class="empty-box admin-empty"><div class="empty-emoji">⚠️</div><div>加载失败</div><div class="empty-sub">${esc(e.message)}</div><button id="btnRetryAdmin" class="btn btn-sm">重试</button></div>`;
      $('#btnRetryAdmin')?.addEventListener('click', loadAdminCoupons);
    }
  }

  function adminCouponCard(r) {
    return couponCardHtml(r, 'admin');
  }

  // 管理员：新建/编辑优惠券弹层
  async function openCouponEditor(id) {
    let c = null;
    if (id) {
      try {
        const res = await DB.adminListCoupons(state.uid);
        c = (res.rows || []).find(x => x.id === id) || null;
      } catch (e) {}
    }
    const mask = document.createElement('div');
    mask.className = 'cp-editor-mask';
    mask.innerHTML = `<div class="cp-editor">
      <div class="cp-editor-hd">${c ? '编辑优惠券' : '新建优惠券'}</div>
      <label>券码 <span class="hint">（批量时留空，会自动生成不同编号）</span></label>
      <div class="cp-code-row">
        <input id="cpCode" value="${c ? esc(c.code) : ''}" ${c ? 'disabled' : ''} placeholder="如 HALF50；批量发券可留空" />
        ${c ? '' : '<button type="button" id="cpRandom" class="btn btn-xs btn-ghost">🎲 随机</button>'}
      </div>
      <label>发券数量 <span class="hint">（1=单张；&gt;1=批量，每张编号不同）</span></label>
      <input id="cpCount" type="number" min="1" max="200" value="1" ${c ? 'disabled' : ''} />
      ${c ? '' : '<div id="cpBatchHint" class="cp-batch-hint"></div>'}
      <label>类型</label>
      <select id="cpType">
        <option value="percent" ${c && c.type === 'percent' ? 'selected' : ''}>打折(percent)</option>
        <option value="cash" ${c && c.type === 'cash' ? 'selected' : ''}>抵现(cash)</option>
        <option value="member_half" ${c && c.type === 'member_half' ? 'selected' : ''}>会员半价</option>
      </select>
      <label>值（抵现=金额元；打折=0~1，0.5=半价）</label>
      <input id="cpValue" type="number" step="0.01" value="${c ? c.value : ''}" />
      <label>满减门槛（0=无门槛，元）</label>
      <input id="cpMin" type="number" step="1" value="${c ? c.min_amount : 0}" />
      <label>过期时间（可空=不过期）</label>
      <input id="cpExpire" type="datetime-local" value="${c && c.expire_at ? toLocalInput(c.expire_at) : ''}" />
      <label>专属会员 auth.id（可空=公开活动码）</label>
      <input id="cpOwner" placeholder="留空=公开" value="${c && c.owner_id ? c.owner_id : ''}" />
      <label>活动标识</label>
      <input id="cpCamp" value="${c ? esc(c.campaign || '') : ''}" />
      <label class="chk-row"><input id="cpActive" type="checkbox" ${!c || c.active ? 'checked' : ''}/><span>启用</span></label>
      <div class="cp-editor-ft">
        <button id="cpCancel" class="btn btn-ghost">取消</button>
        <button id="cpSave" class="btn btn-primary">保存</button>
      </div>
    </div>`;
    document.body.appendChild(mask);
    // 仅「取消」按钮和 Esc 关闭，点击灰色背景不关闭，避免误触丢失填写内容
    let escKey;
    const closeEditor = () => { document.removeEventListener('keydown', escKey); mask.remove(); };
    escKey = (e) => { if (e.key === 'Escape') closeEditor(); };
    document.addEventListener('keydown', escKey);
    $('#cpCancel').addEventListener('click', closeEditor);
    const cpRandom = $('#cpRandom');
    if (cpRandom) cpRandom.addEventListener('click', () => { $('#cpCode').value = genCouponCode(); });
    // 批量发券时动态提示：明确告知将生成几张、编号规则如何
    const cpCount = $('#cpCount');
    const cpCode = $('#cpCode');
    const cpBatchHint = $('#cpBatchHint');
    const cpSave = $('#cpSave');
    function updateBatchHint() {
      if (!cpBatchHint) return;
      const n = parseInt(cpCount.value) || 1;
      const hasCode = (cpCode.value || '').trim();
      if (n <= 1) {
        cpBatchHint.textContent = hasCode ? '' : '券码留空时，请点「随机」或填写一个固定码。';
      } else if (hasCode) {
        cpBatchHint.textContent = `将自动生成 ${n} 张券：${hasCode}-001 至 ${hasCode}-${String(n).padStart(3, '0')}。`;
      } else {
        cpBatchHint.textContent = `将自动生成 ${n} 个不同的 8 位随机券码（每张唯一）。`;
      }
      cpSave.textContent = n > 1 ? `生成 ${n} 张券` : '保存';
    }
    if (cpCount && !c) {
      cpCount.addEventListener('input', updateBatchHint);
      if (cpCode) cpCode.addEventListener('input', updateBatchHint);
      updateBatchHint();
    }
    $('#cpSave').addEventListener('click', async () => {
      const payload = {
        id: id || '',
        code: $('#cpCode').value.trim().toUpperCase(),
        type: $('#cpType').value,
        value: parseFloat($('#cpValue').value) || 0,
        min_amount: parseFloat($('#cpMin').value) || 0,
        expire_at: $('#cpExpire').value ? new Date($('#cpExpire').value).toISOString() : '',
        owner_id: $('#cpOwner').value.trim(),
        campaign: $('#cpCamp').value.trim(),
        active: $('#cpActive').checked,
        count: id ? 1 : (parseInt($('#cpCount').value) || 1)
      };
      const btn = $('#cpSave'); btn.disabled = true; btn.textContent = '保存中…';
      try {
        const r = await DB.adminUpsertCoupon(state.uid, payload);
      if (r.ok) { toast(r.msg || '已保存'); closeEditor(); loadAdminCoupons(); }
      else { toast('失败：' + (r.msg || '')); btn.disabled = false; updateBatchHint(); }
    } catch (e) { toast('异常：' + e.message); btn.disabled = false; updateBatchHint(); }
    });
  }

  // ---------- 管理员：自动发放规则（注册送 / 定期送） ----------
  async function loadAdminRules() {
    const box = $('#adminRuleList');
    if (!box) return;
    box.innerHTML = '<div class="empty">加载中…</div>';
    try {
      const res = await DB.adminListRules(state.uid);
      if (!res || !res.ok) {
        box.innerHTML = `<div class="empty">${esc(res && res.msg ? res.msg : '加载失败')}</div>`;
        return;
      }
      const rows = res.rows || [];
      if (!rows.length) {
        box.innerHTML = `<div class="empty-box admin-empty"><div class="empty-emoji">⚙️</div><div>暂无自动发放规则</div><div class="empty-sub">注册送券 / 定期送券均在此配置</div></div>`;
        return;
      }
      box.innerHTML = `<div class="cp-admin-grid">${rows.map(ruleCardHtml).join('')}</div>`;
      box.querySelectorAll('[data-edit-rule]').forEach(b =>
        b.addEventListener('click', () => openRuleEditor(b.dataset.editRule)));
      box.querySelectorAll('[data-del-rule]').forEach(b =>
        b.addEventListener('click', async () => {
          if (!confirm('确认删除该规则？')) return;
          const d = await DB.adminUpsertRule(state.uid, { id: b.dataset.delRule, _delete: true })
            .catch(e => ({ ok: false, msg: e.message }));
          toast(d.ok ? '已删除' : ('删除失败：' + (d.msg || '')));
          if (d.ok) loadAdminRules();
        }));
      box.querySelectorAll('[data-grant]').forEach(b =>
        b.addEventListener('click', async () => {
          b.disabled = true; const old = b.textContent; b.textContent = '发放中…';
          const g = await DB.grantPeriodicCoupons(state.uid).catch(e => ({ ok: false, msg: e.message }));
          toast(g.ok ? (g.msg || '已发放') : ('发放失败：' + (g.msg || '')));
          if (g.ok) loadAdminRules(); else { b.disabled = false; b.textContent = old; }
        }));
    } catch (e) {
      box.innerHTML = `<div class="empty">规则加载失败：${esc(e.message)}</div>`;
    }
  }

  // 规则卡片
  function ruleCardHtml(r) {
    const trig = r.trigger_type === 'signup' ? '注册送' : '定期送';
    const cyc = r.trigger_type === 'periodic'
      ? (r.cycle === 'daily' ? '每日' : r.cycle === 'weekly' ? '每周' : '每月') : '';
    const tlabel = { percent: '打折', cash: '抵现', member_half: '半价' }[r.type] || r.type;
    const valText = r.type === 'cash' ? '¥' + r.value
      : r.type === 'percent' ? (Math.round((1 - r.value) * 10 * 10) / 10) + '折'
      : '半价';
    const minText = r.min_amount > 0 ? '满¥' + r.min_amount : '无门槛';
    const expText = r.expire_days > 0 ? r.expire_days + '天有效' : '长期有效';
    const status = r.active ? '<span class="cp-tag active">启用</span>' : '<span class="cp-tag used">停用</span>';
    const grantBtn = r.trigger_type === 'periodic'
      ? '<button class="btn btn-xs btn-ghost" data-grant="1">立即发放</button>' : '';
    const valCls = r.type === 'cash' ? 'cash' : r.type === 'percent' ? 'percent' : 'half';
    return `<div class="cp-ticket type-${r.type}">
      <div class="cp-left"><div class="cp-big val-${valCls}">${valText}</div></div>
      <div class="cp-divider"></div>
      <div class="cp-right">
        <div class="cp-title">${trig}${cyc ? ('·' + cyc) : ''}</div>
        <div class="cp-sub">${tlabel} · ${minText} · ${expText}</div>
        <div class="cp-meta">${status}
          <button class="btn btn-xs btn-ghost" data-edit-rule="${r.id}">编辑</button>
          ${grantBtn}
          <button class="btn btn-xs btn-ghost" data-del-rule="${r.id}">删除</button>
        </div>
      </div>
    </div>`;
  }

  // 管理员：新建/编辑自动发券规则弹层
  async function openRuleEditor(id) {
    let r = null;
    if (id) {
      try {
        const res = await DB.adminListRules(state.uid);
        r = (res.rows || []).find(x => x.id === id) || null;
      } catch (e) {}
    }
    const mask = document.createElement('div');
    mask.className = 'cp-editor-mask';
    mask.innerHTML = `<div class="cp-editor">
      <div class="cp-editor-hd">${r ? '编辑规则' : '新建自动发券规则'}</div>
      <label>触发类型</label>
      <select id="ruTrig">
        <option value="signup" ${r && r.trigger_type === 'signup' ? 'selected' : ''}>注册送（新用户注册时自动发）</option>
        <option value="periodic" ${r && r.trigger_type === 'periodic' ? 'selected' : ''}>定期送（按周期自动发）</option>
      </select>
      <label>周期 <span class="hint">（仅定期送需要）</span></label>
      <select id="ruCycle" ${r && r.trigger_type !== 'periodic' ? 'disabled' : ''}>
        <option value="daily" ${r && r.cycle === 'daily' ? 'selected' : ''}>每日</option>
        <option value="weekly" ${r && r.cycle === 'weekly' ? 'selected' : ''}>每周</option>
        <option value="monthly" ${r && r.cycle === 'monthly' ? 'selected' : ''}>每月</option>
      </select>
      <label>券类型</label>
      <select id="ruType">
        <option value="percent" ${r && r.type === 'percent' ? 'selected' : ''}>打折(percent)</option>
        <option value="cash" ${r && r.type === 'cash' ? 'selected' : ''}>抵现(cash)</option>
        <option value="member_half" ${r && r.type === 'member_half' ? 'selected' : ''}>会员半价</option>
      </select>
      <label>值（抵现=金额元；打折=0~1，0.5=半价）</label>
      <input id="ruValue" type="number" step="0.01" value="${r ? r.value : ''}" />
      <label>满减门槛（0=无门槛，元）</label>
      <input id="ruMin" type="number" step="1" value="${r ? r.min_amount : 0}" />
      <label>有效期天数（0=长期有效）</label>
      <input id="ruExpire" type="number" step="1" min="0" value="${r ? r.expire_days : 0}" />
      <label>活动标识</label>
      <input id="ruCamp" value="${r ? esc(r.campaign || '') : ''}" />
      <label class="chk-row"><input id="ruActive" type="checkbox" ${!r || r.active ? 'checked' : ''}/><span>启用</span></label>
      <div class="cp-editor-ft">
        <button id="ruCancel" class="btn btn-ghost">取消</button>
        <button id="ruSave" class="btn btn-primary">保存</button>
      </div>
    </div>`;
    document.body.appendChild(mask);
    let escKey;
    const closeEditor = () => { document.removeEventListener('keydown', escKey); mask.remove(); };
    escKey = (e) => { if (e.key === 'Escape') closeEditor(); };
    document.addEventListener('keydown', escKey);
    $('#ruCancel').addEventListener('click', closeEditor);
    const ruTrig = $('#ruTrig');
    ruTrig.addEventListener('change', () => { $('#ruCycle').disabled = ruTrig.value !== 'periodic'; });
    $('#ruSave').addEventListener('click', async () => {
      const payload = {
        id: id || '',
        trigger_type: $('#ruTrig').value,
        cycle: $('#ruTrig').value === 'periodic' ? $('#ruCycle').value : '',
        type: $('#ruType').value,
        value: parseFloat($('#ruValue').value) || 0,
        min_amount: parseFloat($('#ruMin').value) || 0,
        expire_days: parseInt($('#ruExpire').value) || 0,
        campaign: $('#ruCamp').value.trim(),
        active: $('#ruActive').checked
      };
      const btn = $('#ruSave'); btn.disabled = true; btn.textContent = '保存中…';
      try {
        const res = await DB.adminUpsertRule(state.uid, payload);
        if (res.ok) { toast(res.msg || '已保存'); closeEditor(); loadAdminRules(); }
        else { toast('失败：' + (res.msg || '')); btn.disabled = false; btn.textContent = '保存'; }
      } catch (e) { toast('异常：' + e.message); btn.disabled = false; btn.textContent = '保存'; }
    });
  }

  // 时间转 datetime-local 输入框需要的本地字符串
  function toLocalInput(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  // 生成 8 位大写券码（去掉易混淆字符 0/O/1/I/L）
  function genCouponCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  // ---------- 需求卡片统一渲染 ----------
  // 空状态（带图标与提示）
  function emptyHtml(msg) {
    return `<div class="empty"><div class="empty-emoji">🗂</div><div>${esc(msg)}</div><div class="empty-sub">换个条件试试，或去「发布」一条新需求</div></div>`;
  }
  // 骨架屏（加载中占位，减少等待焦虑）
  function skeletonHtml(n = 3) {
    let h = '';
    for (let i = 0; i < n; i++) {
      h += `<div class="skel-card"><div class="skel-line w60"></div><div class="skel-line w30"></div><div class="skel-line w90"></div><div class="skel-line w40"></div></div>`;
    }
    return h;
  }
  function reqCardsHtml(list, ctx) {
    return list.map(r => cardHtml(r, ctx)).join('');
  }
  function bindReqCards(root) {
    root.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); onCardAction(btn.dataset.act, btn.dataset.id); });
    });
    root.querySelectorAll('[data-detail-id]').forEach(card => {
      card.addEventListener('click', () => openDetail(card.dataset.detailId));
    });
  }
  function renderReqList(list, container, ctx, emptyMsg = '暂无需求') {
    if (!list.length) { container.innerHTML = emptyHtml(emptyMsg); return; }
    container.innerHTML = reqCardsHtml(list, ctx);
    bindReqCards(container);
  }
  // 追加一页卡片（只绑定新节点，避免旧卡片事件重复）
  function appendReqList(list, container, ctx) {
    if (!list.length) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = reqCardsHtml(list, ctx);
    bindReqCards(tmp);
    while (tmp.firstChild) container.appendChild(tmp.firstChild);
  }

  // 卡片：标题+金额 → 标签(类型/倒计时/状态) → 描述 → 发布者+操作
  function cardHtml(r, ctx) {
    const isMine = r.publisher_id === state.uid;
    const isLockedByMe = r.locked_by === state.uid;
    const st = r.status;
    const iAmParty = isMine || isLockedByMe;
    let main = '', subs = '', tail = '';
    if (st === 'open') {
      if (isMine) {
        tail = `<span class="waiting-tag">等待抢单</span>`;
        subs = `<button class="btn btn-sm btn-warn" data-act="del" data-id="${r.id}">撤回</button>`;
      } else {
        main = `<button class="btn btn-primary btn-main" data-act="grab" data-id="${r.id}">抢单</button>`;
      }
    } else if (iAmParty) {
      main = `<button class="btn btn-primary btn-main" data-act="chat" data-id="${r.id}">沟通</button>`;
      if (st === 'locked') {
        // 已抢单后发布者不能直接取消，需先申请；设计师可开始设计
        if (isMine) subs += `<button class="btn btn-sm btn-warn" data-act="requestCancel" data-id="${r.id}">申请取消</button>`;
        if (isLockedByMe) subs += `<button class="btn btn-sm" data-act="start" data-id="${r.id}">开始设计</button>`;
      }
      if (st === 'in_progress') {
        if (isLockedByMe) subs += `<button class="btn btn-sm btn-grab" data-act="done" data-id="${r.id}">标记完成</button>`;
        if (isMine) subs += `<button class="btn btn-sm btn-warn" data-act="requestCancel" data-id="${r.id}">申请取消</button>`;
      }
      if (st === 'cancel_request') {
        if (isMine) subs += `<span class="synced-tag" style="color:#be123c;background:#ffe4e6;">取消申请中</span>`;
        if (isLockedByMe || state.isAdmin) {
          subs += `<button class="btn btn-sm btn-warn" data-act="approveCancel" data-id="${r.id}">同意取消</button>`;
          subs += `<button class="btn btn-sm" data-act="rejectCancel" data-id="${r.id}">拒绝取消</button>`;
        }
      }
      if (r.linked_order_id) {
        subs += `<span class="synced-tag">✓已同步工作台</span>`;
      } else if (st === 'locked' || st === 'in_progress' || st === 'done') {
        subs += `<button class="btn btn-sm btn-ghost" data-act="sync" data-id="${r.id}">同步到工作台</button>`;
      }
    } else {
      tail = `<span class="locked-by">${esc(r.locked_by_name || '设计师')} 已抢单</span>`;
    }
    const budgetRaw = Number(r.budget) || 0;
    const finalRaw = Number(r.final_amount) || 0;
    const hasCoupon = !!r.coupon_code && finalRaw > 0 && finalRaw < budgetRaw;
    const budget = budgetRaw > 0
      ? (hasCoupon
          ? `<span class="req-amount"><s>¥${budgetRaw.toFixed(0)}</s> <b class="amt-final">¥${finalRaw.toFixed(0)}</b></span>`
          : `<span class="req-amount">¥${budgetRaw.toFixed(0)}</span>`)
      : `<span class="req-amount free">面议</span>`;
    const urgency = (st === 'open' && r.deadline) ? countdownHtml(r.deadline) : '';
    const typeTag = `<span class="req-type">${esc(r.task_type || '其他')}</span>`;
    const attTag = (Array.isArray(r.attachments) && r.attachments.length)
      ? `<span class="req-att-tag">📎 ${r.attachments.length} 张参考图</span>` : '';
    const publisherName = visiblePublisherName(r);
    const avatarHtml = `<span class="avatar-xs">${esc(initials(publisherName))}</span>`;
    const who = st === 'open'
      ? `${esc(publisherName)} 发布 · ${fmtTime(r.created_at)}`
      : `${esc(r.locked_by_name || '设计师')} 接单`;
    return `<div class="req-card is-${esc(st)}" data-detail-id="${r.id}">
      <div class="req-head">
        <span class="req-title">${esc(r.title)}</span>
        ${budget}
      </div>
      <div class="req-tags">${typeTag}${attTag}${urgency}${statusBadge(st)}</div>
      <div class="req-desc">${esc(r.description || '（无描述）')}</div>
      <div class="req-foot">
        <span class="pub-by">${avatarHtml}<span class="pub-text">${who}</span></span>
        ${tail}
      </div>
      <div class="req-actions">
        ${subs ? `<div class="req-subs">${subs}</div>` : ''}
        ${main}
      </div>
    </div>`;
  }

  async function onCardAction(act, id) {
    if (act === 'grab') {
      const res = await DB.grab(id, state.uid, state.name);
      if (res && res.ok) {
        // 抢单成功 → 自动落成工作台订单（桥接）。失败不影响抢单，提示可重试。
        let msg = '抢单成功，可开始沟通';
        try {
          const o = await DB.createOrder(id, state.uid);
          if (o && o.ok) {
            msg = o.already
              ? ('抢单成功；工作台订单 #' + o.order_no + ' 已存在')
              : ('抢单成功，已落成工作台订单 #' + o.order_no);
          } else {
            msg = '抢单成功；工作台订单同步失败：' + ((o && o.msg) || '未知');
          }
        } catch (e) {
          msg = '抢单成功；工作台订单同步失败，稍后可重试';
        }
        toast(msg);
        // 状态流转系统消息
        DB.sendSystemMessage(id, state.name + ' 抢走了这个单，可开始沟通 🤝').catch(() => {});
      } else {
        toast((res && res.msg) || '抢单失败');
      }
      if (state.tab === 'board') renderBoard();
    } else if (act === 'sync') {
      // 手动重试桥接：把已抢需求落成（或取回）工作台订单
      try {
        const o = await DB.createOrder(id, state.uid);
        if (o && o.ok) toast('已落成工作台订单 #' + o.order_no);
        else toast((o && o.msg) || '同步失败');
      } catch (e) { toast('同步失败：' + (e.message || '')); }
      if (state.tab === 'board') renderBoard();
      else if (state.tab === 'mine') renderMine();
      else if (state.tab === 'grabbed') renderGrabbed();
    } else if (act === 'chat') {
      openChat(id);
    } else if (act === 'del') {
      if (!confirm('确认撤回该需求？（仅自己未抢走前可撤回）')) return;
      try {
        await DB.softDelete(id, state.uid);
        toast('已撤回');
        if (state.tab === 'board') renderBoard();
        else if (state.tab === 'mine') renderMine();
        else if (state.tab === 'grabbed') renderGrabbed();
      } catch (e) {
        toast('撤回失败：' + (e.message || '请刷新后重试'));
      }
    } else if (act === 'requestCancel') {
      const res = await DB.handleCancel(id, state.uid, 'request');
      toast(res && res.ok ? '已申请取消，等待设计师确认' : (res && res.msg) || '操作失败');
      if (res && res.ok) {
        DB.sendSystemMessage(id, state.name + ' 申请取消该需求，等待接单设计师确认 ⏳').catch(() => {});
        if (state.tab === 'board') renderBoard();
        else if (state.tab === 'mine') renderMine();
        else if (state.tab === 'grabbed') renderGrabbed();
      }
    } else if (act === 'approveCancel') {
      const res = await DB.handleCancel(id, state.uid, 'approve');
      toast(res && res.ok ? '已同意取消' : (res && res.msg) || '操作失败');
      if (res && res.ok) {
        DB.sendSystemMessage(id, state.name + ' 同意了取消申请，需求已关闭 ❌').catch(() => {});
        if (state.tab === 'board') renderBoard();
        else if (state.tab === 'mine') renderMine();
        else if (state.tab === 'grabbed') renderGrabbed();
      }
    } else if (act === 'rejectCancel') {
      const res = await DB.handleCancel(id, state.uid, 'reject');
      toast(res && res.ok ? '已拒绝取消，继续执行' : (res && res.msg) || '操作失败');
      if (res && res.ok) {
        DB.sendSystemMessage(id, state.name + ' 拒绝了取消申请，需求继续执行 ▶️').catch(() => {});
        if (state.tab === 'board') renderBoard();
        else if (state.tab === 'mine') renderMine();
        else if (state.tab === 'grabbed') renderGrabbed();
      }
    } else if (act === 'cancel') {
      // 兜底：open 状态下发布者仍可撤回/取消
      const res = await DB.setStatus(id, state.uid, 'cancelled');
      toast(res && res.ok ? '需求已取消' : (res && res.msg) || '操作失败');
      if (res && res.ok) {
        DB.sendSystemMessage(id, state.name + ' 取消了该需求 ❌').catch(() => {});
        if (state.tab === 'board') renderBoard();
        else if (state.tab === 'mine') renderMine();
        else if (state.tab === 'grabbed') renderGrabbed();
      } else {
        if (state.tab === 'board') renderBoard(); else if (state.tab === 'mine') renderMine();
      }
    } else if (act === 'start') {
      const res = await DB.setStatus(id, state.uid, 'in_progress');
      toast(res && res.ok ? '已开始设计' : (res && res.msg) || '操作失败');
      if (res && res.ok) {
        DB.sendSystemMessage(id, state.name + ' 开始设计，预计交付中 🎨').catch(() => {});
      }
      renderGrabbed();
    } else if (act === 'done') {
      const res = await DB.setStatus(id, state.uid, 'done');
      toast(res && res.ok ? '已标记完成' : (res && res.msg) || '操作失败');
      if (res && res.ok) {
        DB.sendSystemMessage(id, state.name + ' 标记需求完成 ✅').catch(() => {});
      }
      renderGrabbed();
    }
  }

  // ---------- 发布 ----------
  function renderPublish() {
    const el = $('#tabContent');
    const opts = Cfg.TASK_TYPES.map(t => `<option>${t}</option>`).join('');
    state.publishFiles = [];
    el.innerHTML = `<div class="form-card">
      <label>需求标题</label>
      <input id="pTitle" placeholder="如：A4 双面画册设计" maxlength="40" />
      <label>任务类型</label>
      <select id="pType">${opts}</select>
      <label>需求描述</label>
      <textarea id="pDesc" placeholder="尺寸、风格、数量、交付格式等…"></textarea>
      <label>预算（元，可留空=面议）</label>
      <input id="pBudget" type="number" min="0" placeholder="0" />
      <label>优惠券（可选）</label>
      <div class="coupon-row">
        <select id="pCoupon" class="coupon-sel">
          <option value="">不使用优惠券</option>
        </select>
        <input id="pCouponCode" class="coupon-code" type="text" placeholder="或填活动码，如 HALF50" />
      </div>
      <div id="pCouponInfo" class="coupon-info" style="display:none"></div>
      <label>期望交稿时间（可留空=不限）</label>
      <input id="pDeadline" type="datetime-local" />
      <label class="chk-row">
        <input id="pHidePublisher" type="checkbox" />
        <span>未抢单前隐藏我的个人信息（仅显示「匿名发布者」，被抢后向设计师公开）</span>
      </label>
      <label>参考图/素材（可选，最多 6 张）</label>
      <input id="pFiles" type="file" accept="image/*" multiple />
      <div id="pUploads" class="chat-uploads" style="display:none"></div>
      <button id="pSubmit" class="btn btn-primary" style="margin-top:16px">发布需求</button>
    </div>`;
    $('#pFiles').addEventListener('change', (e) => {
      Array.from(e.target.files || []).forEach(f => addPendingPublishFile(f));
      e.target.value = '';
    });
    $('#pSubmit').addEventListener('click', publish);
    // 优惠券：加载我的券 + 预算/券变化时实时算价
    loadMyCoupons();
    $('#pBudget').addEventListener('input', recalcCoupon);
    $('#pCoupon').addEventListener('change', () => {
      $('#pCouponCode').value = '';   // 下拉与手动码二选一
      recalcCoupon();
    });
    $('#pCouponCode').addEventListener('input', () => {
      $('#pCoupon').value = '';       // 手动填码时清空下拉
      recalcCoupon();
    });
  }
  // 加载当前用户可用券到下拉框
  async function loadMyCoupons() {
    const sel = $('#pCoupon');
    if (!sel || !state.uid) return;
    try {
      const list = await DB.listMyCoupons(state.uid);
      const base = '<option value="">不使用优惠券</option>';
      sel.innerHTML = base + list.map(c => {
        const label = couponLabel(c);
        return `<option value="${esc(c.code)}">${esc(label)}</option>`;
      }).join('');
    } catch (e) { /* 券功能未就绪时静默 */ }
  }
  // 把券对象转成可读标签
  function couponLabel(c) {
    let kind = '';
    if (c.type === 'cash') kind = `减¥${c.value}`;
    else if (c.type === 'percent') kind = `打${Number(c.value * 10).toFixed(Number.isInteger(c.value * 10) ? 0 : 1)}折`;
    else if (c.type === 'member_half') kind = '注册会员半价';
    const thr = Number(c.min_amount) > 0 ? `（满¥${c.min_amount}）` : '';
    const who = c.owner_id ? '【专属】' : '';
    return `${who}${c.code} · ${kind}${thr}`;
  }
  // 实时计算折后价并展示
  async function recalcCoupon() {
    const info = $('#pCouponInfo');
    if (!info) return;
    const budget = parseFloat($('#pBudget').value) || 0;
    const code = $('#pCoupon').value || $('#pCouponCode').value.trim();
    if (!code) { info.style.display = 'none'; info.innerHTML = ''; return; }
    try {
      const r = await DB.calcAmount(budget, code, state.uid);
      if (r.ok) {
        const disc = Number(r.discount) || 0;
        info.style.display = 'block';
        info.className = 'coupon-info ok';
        info.innerHTML = disc > 0
          ? `已优惠 ¥${disc.toFixed(0)}，应付 <b>¥${Number(r.final_amount).toFixed(0)}</b>`
          : `当前无优惠（${esc(r.msg)}），应付 ¥${budget.toFixed(0)}`;
      } else {
        info.style.display = 'block';
        info.className = 'coupon-info warn';
        info.innerHTML = esc(r.msg) + `，应付 ¥${budget.toFixed(0)}`;
      }
    } catch (e) {
      info.style.display = 'none';
    }
  }
  // 发布参考图：加入待上传列表（图片压缩 + 预览，最多 6 张）
  async function addPendingPublishFile(file) {
    if ((state.publishFiles || []).length >= 6) { toast('最多 6 张参考图'); return; }
    if (file.size > 10 * 1024 * 1024) { toast('单张不能超过 10MB'); return; }
    try {
      const blob = await compressImage(file);
      state.publishFiles.push({
        file: blob, name: file.name, size: blob.size,
        mime: 'image/jpeg', thumb: URL.createObjectURL(blob)
      });
    } catch (e) {
      toast('图片读取失败：' + file.name);
    }
    renderPublishUploads();
  }
  function renderPublishUploads() {
    const wrap = $('#pUploads');
    const list = state.publishFiles || [];
    if (!list.length) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
    wrap.style.display = 'flex';
    wrap.innerHTML = list.map((f, i) => `<div class="upload-chip">
      ${f.thumb ? `<a class="msg-img-link" data-img="${esc(f.thumb)}" title="点击放大"><img class="upload-thumb" src="${f.thumb}" alt="" /></a>` : '<span class="upload-ico">📄</span>'}
      <span class="upload-name">${esc(f.name)}</span>
      <button type="button" class="upload-rm" data-i="${i}" title="移除">✕</button>
    </div>`).join('');
    wrap.querySelectorAll('.upload-rm').forEach(b =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = +b.dataset.i;
        const f = state.publishFiles[i];
        if (f && f.thumb) URL.revokeObjectURL(f.thumb);
        state.publishFiles.splice(i, 1);
        renderPublishUploads();
      }));
  }
  async function publish() {
    const title = $('#pTitle').value.trim();
    if (!title) { toast('请填写标题'); return; }
    const desc = $('#pDesc').value.trim();
    const budget = parseFloat($('#pBudget').value) || 0;
    const dl = $('#pDeadline').value;
    const deadline = dl ? new Date(dl).toISOString() : null;
    const couponCode = ($('#pCoupon').value || $('#pCouponCode').value.trim() || '');
    const hidePublisher = !!$('#pHidePublisher') && $('#pHidePublisher').checked;
    const files = state.publishFiles || [];
    const btn = $('#pSubmit');
    btn.disabled = true;
    btn.textContent = files.length ? '上传中…' : '发布中…';
    try {
      // 先算折后价（券无效则按原价发布）
      let finalAmount = budget;
      let discount = 0;
      if (couponCode) {
        const cr = await DB.calcAmount(budget, couponCode, state.uid).catch(() => null);
        if (cr && cr.ok) { finalAmount = Number(cr.final_amount) || budget; discount = Number(cr.discount) || 0; }
      }
      const row = await DB.insertRequirement({
        publisher_id: state.uid,
        publisher_name: state.name,
        title,
        description: desc,
        task_type: $('#pType').value,
        budget,
        deadline,
        coupon_code: couponCode,
        final_amount: finalAmount,
        hide_publisher: hidePublisher
      });
      // 发布成功即核销券（防止被重复使用）
      if (couponCode) await DB.redeemCoupon(state.uid, couponCode).catch(() => {});
      // 参考图：先建需求拿到 id，再传附件并回写
      if (files.length && row && row.id) {
        const attachments = [];
        for (const f of files) {
          const up = await DB.uploadAttachment(row.id, f.file);
          attachments.push({ name: f.name, size: f.size, mime: f.mime, url: up.url, path: up.path });
        }
        await DB.updateRequirementAttachments(row.id, attachments);
      }
      state.publishFiles = [];
      toast('已发布');
      switchTab('board');
    } catch (e) {
      toast('发布失败：' + (e.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = '发布需求';
    }
  }

  // ---------- 聊天 ----------
  async function openChat(reqId) {
    let req = await DB.getRequirement(reqId).catch(() => null); // 分页后按 id 直查最新快照
    if (!req) req = (await DB.listMine(state.uid).catch(() => [])).find(r => r.id === reqId);
    if (!req) { toast('需求不存在'); return; }
    state.chatReq = req;
    $('#chatTitle').textContent = req.title + ' · 沟通';
    $('#chatMask').style.display = 'flex';
    $('#chatBody').innerHTML = '';
    resetChatDraft();
    const msgs = await DB.listMessages(reqId).catch(() => []);
    msgs.forEach(appendMsg);
    $('#chatBody').scrollTop = $('#chatBody').scrollHeight;
    // 标记为已读：记下最大消息时间，下次刷新 Inbox 时该会话不再算未读
    if (msgs.length) {
      const maxAt = msgs.reduce((a, m) => (a > m.created_at ? a : m.created_at), msgs[0].created_at);
      localStorage.setItem('lastReadAt_' + reqId, maxAt);
    } else {
      localStorage.setItem('lastReadAt_' + reqId, new Date().toISOString());
    }
    refreshInbox(); // 立即清零该会话未读

    if (state.chatCh) DB.unsubscribe(state.chatCh);
    state.chatCh = DB.subscribeChat(reqId, (row) => {
      appendMsg(row);
      // 聊天打开时收到的新消息：把 lastRead 推到这条消息的时间，避免下一轮 refresh 又算未读
      if (row.created_at) localStorage.setItem('lastReadAt_' + reqId, row.created_at);
    });
  }
  function appendMsg(m) {
    const me = m.sender_id === state.uid;
    const div = document.createElement('div');
    div.className = 'msg' + (me ? ' me' : '') + (m.msg_type === 'system' ? ' sys' : '');
    // 系统消息：居中灰显，不挂头像/气泡
    if (m.msg_type === 'system') {
      div.innerHTML = `<div class="msg-sys">${esc(m.body)}</div>`;
      $('#chatBody').appendChild(div);
      $('#chatBody').scrollTop = $('#chatBody').scrollHeight;
      return;
    }
    const atts = Array.isArray(m.attachments) ? m.attachments : [];
    let attHtml = '';
    if (atts.length) {
      const imgs = atts.filter(a => (a.mime || '').startsWith('image/'));
      const files = atts.filter(a => !(a.mime || '').startsWith('image/'));
      if (imgs.length) {
        attHtml += `<div class="msg-media">` + imgs.map(a =>
          `<a class="msg-img-link" data-img="${esc(a.url)}" title="点击放大"><img class="msg-img" src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy" /></a>`
        ).join('') + `</div>`;
      }
      if (files.length) {
        attHtml += files.map(a =>
          `<a class="msg-file" href="${esc(a.url)}" target="_blank" rel="noopener" download>
            <span class="msg-file-ico">📄</span>
            <span class="msg-file-name">${esc(a.name)}</span>
            <span class="msg-file-size">${fmtSize(a.size)}</span>
          </a>`).join('');
      }
    }
    const bodyHtml = m.body ? `<div class="msg-bubble">${esc(m.body)}</div>` : '';
    div.innerHTML = `<div class="msg-name">${esc(m.sender_name || (me ? '我' : '对方'))}</div>
      ${attHtml}
      ${bodyHtml}
      <div class="msg-time">${fmtTime(m.created_at)}</div>`;
    $('#chatBody').appendChild(div);
    $('#chatBody').scrollTop = $('#chatBody').scrollHeight;
  }
  // 聊天附件 / 表情相关工具
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  // 图片压缩：长边 ≤ 1600px、JPEG 0.82，手机原图也能压到几百 KB~2MB
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const MAX = 1600;
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) {
          const ratio = Math.min(MAX / w, MAX / h);
          w = Math.round(w * ratio); h = Math.round(h * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          if (!blob) { reject(new Error('图片压缩失败')); return; }
          blob.name = file.name; blob.lastModified = file.lastModified;
          resolve(blob);
        }, 'image/jpeg', 0.82);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });
  }
  // 加入待发送列表（图片先压缩并生成预览缩略图）
  async function addPendingFile(file) {
    const MAX = 10 * 1024 * 1024;
    if (file.size > MAX) { toast('单个文件不能超过 10MB'); return; }
    const isImage = (file.type || '').startsWith('image/');
    const item = {
      file, name: file.name, size: file.size,
      mime: file.type || 'application/octet-stream', isImage, thumb: ''
    };
    if (isImage) {
      try {
        const blob = await compressImage(file);
        item.file = blob; item.size = blob.size;
        item.thumb = URL.createObjectURL(blob);
      } catch (e) {
        item.isImage = false; item.mime = 'application/octet-stream';
      }
    }
    state.chatFiles.push(item);
    renderUploads();
  }
  function renderUploads() {
    const wrap = $('#chatUploads');
    const list = state.chatFiles || [];
    if (!list.length) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
    wrap.style.display = 'flex';
    wrap.innerHTML = list.map((f, i) => `<div class="upload-chip">
      ${f.isImage && f.thumb ? `<img class="upload-thumb" src="${f.thumb}" alt="" />` : '<span class="upload-ico">📄</span>'}
      <span class="upload-name">${esc(f.name)}</span>
      <span class="upload-size">${fmtSize(f.size)}</span>
      <button type="button" class="upload-rm" data-i="${i}" title="移除">✕</button>
    </div>`).join('');
    wrap.querySelectorAll('.upload-rm').forEach(b =>
      b.addEventListener('click', () => {
        const i = +b.dataset.i;
        const f = state.chatFiles[i];
        if (f && f.thumb) URL.revokeObjectURL(f.thumb);
        state.chatFiles.splice(i, 1);
        renderUploads();
      }));
  }
  function resetChatDraft() {
    (state.chatFiles || []).forEach(f => { if (f.thumb) URL.revokeObjectURL(f.thumb); });
    state.chatFiles = [];
    renderUploads();
    const ep = $('#chatEmojiPanel'); if (ep) ep.style.display = 'none';
    const inp = $('#chatText'); if (inp) inp.value = '';
  }
  function closeChat() {
    $('#chatMask').style.display = 'none';
    if (state.chatCh) { DB.unsubscribe(state.chatCh); state.chatCh = null; }
    resetChatDraft();
  }
  // 桌面端：按住标题栏拖动聊天窗口（移动端保持底部抽屉，不启用）
  function enableChatDrag() {
    const panel = document.querySelector('.chat-panel');
    const head = document.querySelector('.chat-head');
    if (!panel || !head) return;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.btn-ghost')) return; // 点关闭按钮不触发拖动
      if (window.innerWidth < 720) return;        // 移动端底部抽屉不拖动
      const rect = panel.getBoundingClientRect();
      const offX = e.clientX - rect.left;
      const offY = e.clientY - rect.top;
      const move = (ev) => {
        let x = ev.clientX - offX;
        let y = ev.clientY - offY;
        x = Math.max(0, Math.min(x, window.innerWidth - panel.offsetWidth));
        y = Math.max(0, Math.min(y, window.innerHeight - panel.offsetHeight));
        panel.style.left = x + 'px';
        panel.style.top = y + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }
  function bindChat() {
    $('#chatClose').addEventListener('click', closeChat);
    $('#chatMask').addEventListener('click', (e) => { if (e.target.id === 'chatMask') closeChat(); });
    enableChatDrag();
    $('#chatSend').addEventListener('click', sendChat);
    $('#chatText').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) sendChat(); // isComposing：避免中文输入法回车误发送
    });
    // 粘贴图片直接加入待发送
    $('#chatText').addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      let hit = false;
      for (const it of items) {
        if (it.type && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) { addPendingFile(f); hit = true; }
        }
      }
      if (hit) e.preventDefault();
    });
    // 表情面板
    const EMOJIS = ['😀','😄','😁','😂','🤣','😊','😉','😍','🥰','😘','😜','🤗','🤔','😴','😅','😭','😤','👍','👎','👏','🙏','💪','🤝','👌','✌️','❤️','💯','🔥','⭐','🎉','🎨','🖌️','📐','📄','✅','❌','⏰','💰'];
    const ep = $('#chatEmojiPanel');
    if (ep && !ep.childElementCount) {
      ep.innerHTML = EMOJIS.map(e => `<button type="button" class="emoji-item" data-e="${esc(e)}">${e}</button>`).join('');
      ep.addEventListener('click', (ev) => {
        const b = ev.target.closest('.emoji-item'); if (!b) return;
        const inp = $('#chatText');
        inp.value += b.dataset.e;
        inp.focus();
      });
    }
    $('#btnChatEmoji').addEventListener('click', () => {
      const p = $('#chatEmojiPanel');
      p.style.display = p.style.display === 'flex' ? 'none' : 'flex';
    });
    // 附件选择（可多选）
    $('#btnChatAttach').addEventListener('click', () => $('#chatFile').click());
    $('#chatFile').addEventListener('change', (e) => {
      Array.from(e.target.files || []).forEach(f => addPendingFile(f));
      e.target.value = '';
    });
  }
  async function sendChat() {
    if (!state.chatReq) return;
    const txt = $('#chatText').value.trim();
    const files = state.chatFiles || [];
    if (!txt && !files.length) return;
    const btn = $('#chatSend');
    btn.disabled = true;
    btn.textContent = files.length ? '上传中…' : '发送中…';
    try {
      let attachments = [];
      if (files.length) {
        for (const f of files) {
          const up = await DB.uploadAttachment(state.chatReq.id, f.file);
          attachments.push({
            name: f.name, size: f.size, mime: f.mime,
            url: up.url, path: up.path,
            thumb: (f.mime || '').startsWith('image/') ? up.url : null
          });
        }
      }
      const msgType = !attachments.length ? 'text'
        : attachments.every(a => (a.mime || '').startsWith('image/')) ? 'image' : 'file';
      await DB.sendMessage(state.chatReq.id, state.uid, state.name, txt, attachments, msgType);
      $('#chatText').value = '';
      resetChatDraft();
      // 实时订阅会追加消息；这里不手动 append 避免重复（subscription 回调负责）
    } catch (e) {
      toast('发送失败：' + (e.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = '发送';
    }
  }

  // ---------- 详情抽屉 ----------
  async function openDetail(reqId) {
    // 拉最新需求（先按 id 直查，再回退到我发布的/我抢的）
    let r = await DB.getRequirement(reqId).catch(() => null);
    if (!r) r = (await DB.listMine(state.uid).catch(() => [])).find(x => x.id === reqId);
    if (!r) r = (await DB.listGrabbed(state.uid).catch(() => [])).find(x => x.id === reqId);
    if (!r) { toast('需求不存在或已撤回'); return; }
    state.detailReq = r;
    const st = r.status;
    const stMeta = Cfg.STATUS[st] || { label: st, color: '#64748b' };
    $('#detailStatus').textContent = stMeta.label;
    $('#detailStatus').style.background = stMeta.color;
    $('#detailTitle').textContent = r.title;
    $('#detailMask').classList.add('right-mask');
    $('#detailMask').style.display = 'flex';
    $('#detailBody').innerHTML = `<div class="empty">加载中…</div>`;
    // 详情内容（含发布者统计）
    let stats = { total: 0, done: 0 };
    try { stats = await DB.getPublisherStats(r.publisher_id); } catch (e) {}
    const budgetRaw = Number(r.budget) || 0;
    const finalRaw = Number(r.final_amount) || 0;
    const hasCoupon = !!r.coupon_code && finalRaw > 0 && finalRaw < budgetRaw;
    const budget = Number(r.budget) > 0
      ? (hasCoupon ? `¥${budgetRaw.toFixed(0)} → <b style="color:#16a34a">¥${finalRaw.toFixed(0)}</b>` : `¥${budgetRaw.toFixed(0)}`)
      : '面议';
    const dlStr = r.deadline ? fmtTime(r.deadline) + (new Date(r.deadline) > new Date() ? `（${countdownHtml(r.deadline).replace(/<[^>]+>/g,'')}）` : '') : '不限';
    const html = `
      <div class="drawer-meta-row">
        <div class="item"><div class="label">预算</div><div class="value">${budget}</div></div>
        <div class="item"><div class="label">截止时间</div><div class="value">${esc(dlStr)}</div></div>
        <div class="item"><div class="label">任务类型</div><div class="value">${esc(r.task_type)}</div></div>
        <div class="item"><div class="label">发布时间</div><div class="value">${esc(fmtTime(r.created_at))}</div></div>
      </div>
      ${hasCoupon ? `<div class="drawer-coupon">已使用优惠码 <b>${esc(r.coupon_code)}</b>，最终应付 ¥${finalRaw.toFixed(0)}（原价 ¥${budgetRaw.toFixed(0)}）</div>` : ''}
      <div class="drawer-section">
        <div class="label">需求描述</div>
        <div class="value">${esc(r.description || '（无描述）')}</div>
      </div>
      ${(Array.isArray(r.attachments) && r.attachments.length) ? `<div class="drawer-section">
        <div class="label">参考图/素材</div>
        <div class="drawer-refs">${r.attachments.map(a =>
          `<a class="msg-img-link" data-img="${esc(a.url)}" title="点击放大"><img class="msg-img" src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy" /></a>`
        ).join('')}</div>
      </div>` : ''}
      <div class="drawer-section">
        <div class="label">发布者</div>
        <div class="drawer-publisher">
          <span class="avatar-sm">${esc(initials(visiblePublisherName(r)))}</span>
          <div class="info">
            <div class="name">${esc(visiblePublisherName(r))}</div>
            ${canSeePublisher(r)
              ? `<div class="stats">累计发布 ${stats.total} 单 · 已完成 ${stats.done} 单</div>`
              : `<div class="stats">需求被抢后向设计师公开</div>`}
          </div>
        </div>
      </div>
      ${r.locked_by ? `<div class="drawer-section">
        <div class="label">锁定设计师</div>
        <div class="drawer-publisher">
          <span class="avatar-sm">${esc(initials(r.locked_by_name))}</span>
          <div class="info"><div class="name">${esc(r.locked_by_name || '设计师')}</div></div>
        </div>
      </div>` : ''}
      ${r.linked_order_id ? `<div class="drawer-section">
        <div class="label">工作台订单</div>
        <div class="value" style="color:#16a34a;font-weight:600">✓ 已同步（#${esc(r.linked_order_id.slice(0, 8))}…）</div>
      </div>` : ''}
    `;
    $('#detailBody').innerHTML = html;
    // 参考图点击放大（lightbox）
    $('#detailBody').querySelectorAll('.msg-img-link[data-img]').forEach(a =>
      a.addEventListener('click', (e) => { e.preventDefault(); openLightbox(a.dataset.img); }));
    // 详情底部动作按钮（与卡片同逻辑）
    const isMine = r.publisher_id === state.uid;
    const isLockedByMe = r.locked_by === state.uid;
    let acts = '';
    if (st === 'open' && !isMine) {
      acts = `<button class="btn btn-primary" data-act="grab" data-id="${r.id}">抢单</button>`;
    } else if (isMine || isLockedByMe) {
      acts = `<button class="btn btn-primary" data-act="chat" data-id="${r.id}">沟通</button>`;
      if (st === 'locked' && isLockedByMe) acts += `<button class="btn" data-act="start" data-id="${r.id}">开始设计</button>`;
      if (st === 'locked' && isMine) acts += `<button class="btn btn-warn" data-act="requestCancel" data-id="${r.id}">申请取消</button>`;
      if (st === 'in_progress' && isLockedByMe) acts += `<button class="btn btn-grab" data-act="done" data-id="${r.id}">标记完成</button>`;
      if (st === 'in_progress' && isMine) acts += `<button class="btn btn-warn" data-act="requestCancel" data-id="${r.id}">申请取消</button>`;
      if (st === 'cancel_request') {
        if (isMine) acts += `<span class="synced-tag" style="color:#be123c;background:#ffe4e6;">取消申请中</span>`;
        if (isLockedByMe || state.isAdmin) {
          acts += `<button class="btn btn-warn" data-act="approveCancel" data-id="${r.id}">同意取消</button>`;
          acts += `<button class="btn" data-act="rejectCancel" data-id="${r.id}">拒绝取消</button>`;
        }
      }
    }
    if (!acts && (isMine || isLockedByMe)) acts = `<button class="btn btn-primary" data-act="chat" data-id="${r.id}">沟通</button>`;
    $('#detailActions').innerHTML = acts;
    $('#detailActions').querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => { closeDetail(); onCardAction(btn.dataset.act, btn.dataset.id); });
    });
  }
  function closeDetail() {
    $('#detailMask').style.display = 'none';
    state.detailReq = null;
  }

  // ---------- Inbox 会话列表 ----------
  async function refreshInbox() {
    try {
      const chats = await DB.listMyChats(state.uid);
      state.chats = chats;
      // 客户端再算一次未读（避免 listMyChats 内部逻辑遗漏）
      state.unreadTotal = 0;
      chats.forEach(c => { state.unreadTotal += (c.unread || 0); });
      const dot = $('#inboxDot');
      if (dot) dot.hidden = state.unreadTotal === 0;
    } catch (e) { /* 静默 */ }
  }
  // ---------- 未读消息悬浮提示 ----------
  let _msgToastTimer = null;
  async function showMsgToast(row) {
    const box = $('#msgToast');
    if (!box) return;
    // 取需求标题（先查缓存会话，回退到直查）
    let title = '新消息';
    const cached = (state.chats || []).find(c => c.id === row.requirement_id);
    if (cached) title = cached.title;
    else {
      const r = await DB.getRequirement(row.requirement_id).catch(() => null);
      if (r) title = r.title;
    }
    const isSys = row.msg_type === 'system';
    const prefix = isSys ? '📌 ' : (row.sender_name ? (row.sender_name + '：') : '');
    let preview = row.body || '';
    if (!preview && Array.isArray(row.attachments) && row.attachments.length) {
      const hasImg = row.attachments.some(a => (a.mime || '').startsWith('image/'));
      preview = hasImg ? '[图片]' : '[文件]';
    }
    if (preview.length > 28) preview = preview.slice(0, 28) + '…';
    box.innerHTML = `<div class="mt-head">
        <span class="mt-title">${esc(title)}</span>
        <button class="mt-close" title="关闭">✕</button>
      </div>
      <div class="mt-body">${esc(prefix + preview)}</div>`;
    box.onclick = (e) => {
      if (e.target.closest('.mt-close')) { hideMsgToast(); return; }
      hideMsgToast();
      closeInbox();
      openChat(row.requirement_id);
    };
    box.style.display = 'block';
    // 重新触发入场动画
    box.classList.remove('show');
    void box.offsetWidth;
    box.classList.add('show');
    clearTimeout(_msgToastTimer);
    _msgToastTimer = setTimeout(hideMsgToast, 4000);
  }
  function hideMsgToast() {
    const box = $('#msgToast');
    if (!box) return;
    box.classList.remove('show');
    box.style.display = 'none';
    clearTimeout(_msgToastTimer);
  }

  function renderInbox() {
    const list = state.chats || [];
    const body = $('#inboxBody');
    if (!list.length) {
      body.innerHTML = `<div class="empty">暂无会话，去「大厅」抢单或「发布」需求试试</div>`; return;
    }
    body.innerHTML = list.map(c => {
      const iAmPub = c.publisher_id === state.uid;
      const other = iAmPub ? (c.locked_by_name || '等待抢单') : (c.publisher_name || '匿名');
      const stMeta = Cfg.STATUS[c.status] || { label: c.status, color: '#64748b' };
      const isSys = c.last_message_type === 'system';
      const msg = c.last_message
        ? (isSys ? '📌 ' + c.last_message : c.last_message)
        : (c.status === 'open' ? '（等待抢单中）' : '（暂无消息）');
      const hasUnread = (c.unread || 0) > 0;
      return `<div class="inbox-item" data-inbox-id="${c.id}">
        <div class="inbox-meta">
          <div class="inbox-meta-top">
            <span class="inbox-title">${esc(c.title)}</span>
            <span class="inbox-time">${esc(fmtTime(c.last_message_at || c.updated_at))}</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            <span class="inbox-msg ${hasUnread ? 'has-unread' : ''}" style="flex:1">${esc(other)}：${esc(msg)}</span>
            ${hasUnread ? `<span class="inbox-badge">${c.unread}</span>` : ''}
            <span class="inbox-status" style="background:${stMeta.color};color:#fff">${esc(stMeta.label)}</span>
          </div>
        </div>
      </div>`;
    }).join('');
    body.querySelectorAll('[data-inbox-id]').forEach(el => {
      el.addEventListener('click', () => { closeInbox(); openChat(el.dataset.inboxId); });
    });
  }
  async function openInbox() {
    await refreshInbox();
    renderInbox();
    $('#inboxMask').classList.add('right-mask');
    $('#inboxMask').style.display = 'flex';
  }
  function closeInbox() {
    $('#inboxMask').style.display = 'none';
  }

  // ---------- 图片放大预览（lightbox） ----------
  function openLightbox(url) {
    const lb = $('#lightbox');
    if (!lb) return;
    $('#lightboxImg').src = url;
    lb.style.display = 'flex';
  }
  function closeLightbox() {
    const lb = $('#lightbox');
    if (!lb) return;
    lb.style.display = 'none';
    $('#lightboxImg').src = '';
  }
  // 全局事件委托：聊天 / 详情里的图片点击放大
  document.addEventListener('click', (e) => {
    const link = e.target.closest('.msg-img-link[data-img]');
    if (link) { e.preventDefault(); openLightbox(link.dataset.img); return; }
    if (e.target.id === 'lightbox' || e.target.id === 'lightboxClose') closeLightbox();
  });
  // Esc 关闭：抽屉 / 聊天窗口 / lightbox
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('#lightbox') && $('#lightbox').style.display === 'flex') { closeLightbox(); return; }
    if ($('#detailMask') && $('#detailMask').style.display === 'flex') { closeDetail(); return; }
    if ($('#inboxMask') && $('#inboxMask').style.display === 'flex') { closeInbox(); return; }
    if ($('#chatMask') && $('#chatMask').style.display === 'flex') { closeChat(); return; }
  });

  // ---------- 初始化 ----------
  function init() {
    bindAuth();
    bindTabs();
    bindChat();
    // 注册 Service Worker（独立缓存空间 dr-pwa，与工作台互不干扰）
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
          .catch(() => {}); // 注册失败不影响功能，仅少离线能力
      });
    }
    DB.onAuthChange((event, session) => {
      if (event === 'SIGNED_IN' && session) enterApp(session.user);
      else if (event === 'SIGNED_OUT') { location.reload(); }
    });
    boot();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
