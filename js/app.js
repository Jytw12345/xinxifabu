/* ============================================================
 * app.js  —  设计需求发布平台 主逻辑
 * 登录/注册 · 需求大厅 · 我发布的 · 我抢的 · 发布 · 抢单 · 实时聊天
 * ============================================================ */
(function () {
  const $ = (s) => document.querySelector(s);
  const APPV = 'v6';

  const state = {
    uid: null,
    name: '',
    tab: 'board',
    boardKeyword: '',
    boardFilter: '全部',   // 类型
    boardStatus: 'open',   // 状态筛选
    boardSort: 'newest',   // 排序
    boardCh: null,         // 大厅实时订阅
    chatCh: null,          // 当前聊天订阅
    chatReq: null,
    chatFiles: [],         // 当前聊天待发送附件
    chats: [],             // Inbox 会话列表缓存
    unreadTotal: 0
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
    const { data } = await DB.getSession();
    if (data && data.session) {
      await enterApp(data.session.user);
    } else {
      hideSplash();
      showAuth();
    }
  }

  async function enterApp(user) {
    state.uid = user.id;
    state.name = await DB.myDisplayName();
    $('#userName').textContent = state.name;
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
    state.inboxCh = DB.subscribeAllMessages(() => refreshInbox());
    refreshInbox();
    switchTab('board');
  }

  // ---------- 认证 ----------
  let authMode = 'login';
  function bindAuth() {
    document.querySelectorAll('.seg-btn').forEach(b => b.addEventListener('click', () => {
      authMode = b.dataset.mode;
      document.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('active', x === b));
      $('#authSubmit').textContent = authMode === 'login' ? '登录' : '注册并进入';
      $('#authHint').textContent = '';
    }));
    $('#authSubmit').addEventListener('click', async () => {
      const email = $('#authEmail').value.trim();
      const pwd = $('#authPwd').value;
      if (!email || pwd.length < 6) { $('#authHint').textContent = '请输入邮箱与≥6位密码'; return; }
      $('#authHint').textContent = '处理中…';
      try {
        if (authMode === 'login') {
          const { error } = await DB.signIn(email, pwd);
          if (error) throw error;
          // onAuthStateChange 会触发 enterApp
        } else {
          const { data, error } = await DB.signUp({ email, password: pwd });
          if (error) throw error;
          if (data.session) {
            // 关了邮箱验证：直接登录
          } else {
            $('#authHint').textContent = '注册成功，请查收验证邮件后登录';
            authMode = 'login';
            document.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('active', x.dataset.mode === 'login'));
            $('#authSubmit').textContent = '登录';
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
    const titleMap = { board: '需求大厅', mine: '我发布的', grabbed: '我抢的', publish: '发布需求' };
    $('.topbar-title').textContent = titleMap[tab] || '需求大厅';
    const fab = $('#fabPublish');
    if (fab) fab.classList.toggle('hide-fab', tab === 'publish');
    if (tab === 'board') renderBoard();
    else if (tab === 'mine') renderMine();
    else if (tab === 'grabbed') renderGrabbed();
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
      ['done', '已完成'], ['cancelled', '已取消'], ['all', '全部状态']
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
    </div><div id="boardList"></div>`;

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
    const box = $('#boardList'); if (!box) return;
    box.innerHTML = skeletonHtml(2);
    refreshBoardStats();
    let list;
    try {
      list = await DB.listBoard({
        keyword: state.boardKeyword, type: state.boardFilter,
        status: state.boardStatus, sort: state.boardSort
      });
    } catch (e) {
      if (token !== _boardReqToken) return;
      box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return;
    }
    if (token !== _boardReqToken) return;
    renderReqList(list, box, 'board', '没有找到匹配的需求');
  }
  async function loadBoardList() {
    const box = $('#boardList'); if (!box) return;
    box.innerHTML = skeletonHtml(3);
    let list;
    try {
      list = await DB.listBoard({
        keyword: state.boardKeyword, type: state.boardFilter,
        status: state.boardStatus, sort: state.boardSort
      });
    } catch (e) {
      box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return;
    }
    renderReqList(list, box, 'board', '没有找到匹配的需求');
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
  function renderReqList(list, container, ctx, emptyMsg = '暂无需求') {
    if (!list.length) { container.innerHTML = emptyHtml(emptyMsg); return; }
    container.innerHTML = list.map(r => cardHtml(r, ctx)).join('');
    container.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); onCardAction(btn.dataset.act, btn.dataset.id); });
    });
    container.querySelectorAll('[data-detail-id]').forEach(card => {
      card.addEventListener('click', () => openDetail(card.dataset.detailId));
    });
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
        if (isMine) subs += `<button class="btn btn-sm btn-warn" data-act="cancel" data-id="${r.id}">取消需求</button>`;
        if (isLockedByMe) subs += `<button class="btn btn-sm" data-act="start" data-id="${r.id}">开始设计</button>`;
      }
      if (st === 'in_progress') {
        if (isLockedByMe) subs += `<button class="btn btn-sm btn-grab" data-act="done" data-id="${r.id}">标记完成</button>`;
        if (isMine) subs += `<button class="btn btn-sm btn-warn" data-act="cancel" data-id="${r.id}">取消</button>`;
      }
      if (r.linked_order_id) {
        subs += `<span class="synced-tag">✓已同步工作台</span>`;
      } else if (st === 'locked' || st === 'in_progress' || st === 'done') {
        subs += `<button class="btn btn-sm btn-ghost" data-act="sync" data-id="${r.id}">同步到工作台</button>`;
      }
    } else {
      tail = `<span class="locked-by">${esc(r.locked_by_name || '设计师')} 已抢单</span>`;
    }
    const budget = Number(r.budget) > 0
      ? `<span class="req-amount">¥${Number(r.budget).toFixed(0)}</span>`
      : `<span class="req-amount free">面议</span>`;
    const urgency = (st === 'open' && r.deadline) ? countdownHtml(r.deadline) : '';
    const typeTag = `<span class="req-type">${esc(r.task_type || '其他')}</span>`;
    const publisherName = r.publisher_name || '匿名';
    const avatarHtml = `<span class="avatar-xs">${esc(initials(publisherName))}</span>`;
    const who = st === 'open'
      ? `${esc(publisherName)} 发布 · ${fmtTime(r.created_at)}`
      : `${esc(r.locked_by_name || '设计师')} 接单`;
    return `<div class="req-card is-${esc(st)}" data-detail-id="${r.id}">
      <div class="req-head">
        <span class="req-title">${esc(r.title)}</span>
        ${budget}
      </div>
      <div class="req-tags">${typeTag}${urgency}${statusBadge(st)}</div>
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
      await DB.softDelete(id);
      toast('已撤回'); renderMine();
    } else if (act === 'cancel') {
      const res = await DB.setStatus(id, state.uid, 'cancelled');
      toast(res && res.ok ? '需求已取消' : (res && res.msg) || '操作失败');
      if (state.tab === 'board') renderBoard(); else if (state.tab === 'mine') renderMine();
    } else if (act === 'start') {
      const res = await DB.setStatus(id, state.uid, 'in_progress');
      toast(res && res.ok ? '已开始设计' : (res && res.msg) || '操作失败');
      renderGrabbed();
    } else if (act === 'done') {
      const res = await DB.setStatus(id, state.uid, 'done');
      toast(res && res.ok ? '已标记完成' : (res && res.msg) || '操作失败');
      renderGrabbed();
    }
  }

  // ---------- 发布 ----------
  function renderPublish() {
    const el = $('#tabContent');
    const opts = Cfg.TASK_TYPES.map(t => `<option>${t}</option>`).join('');
    el.innerHTML = `<div class="form-card">
      <label>需求标题</label>
      <input id="pTitle" placeholder="如：A4 双面画册设计" maxlength="40" />
      <label>任务类型</label>
      <select id="pType">${opts}</select>
      <label>需求描述</label>
      <textarea id="pDesc" placeholder="尺寸、风格、数量、交付格式等…"></textarea>
      <label>预算（元，可留空=面议）</label>
      <input id="pBudget" type="number" min="0" placeholder="0" />
      <label>期望交稿时间（可留空=不限）</label>
      <input id="pDeadline" type="datetime-local" />
      <button id="pSubmit" class="btn btn-primary" style="margin-top:16px">发布需求</button>
    </div>`;
    $('#pSubmit').addEventListener('click', publish);
  }
  async function publish() {
    const title = $('#pTitle').value.trim();
    if (!title) { toast('请填写标题'); return; }
    const desc = $('#pDesc').value.trim();
    const budget = parseFloat($('#pBudget').value) || 0;
    const dl = $('#pDeadline').value;
    const deadline = dl ? new Date(dl).toISOString() : null;
    try {
      await DB.insertRequirement({
        publisher_id: state.uid,
        publisher_name: state.name,
        title,
        description: desc,
        task_type: $('#pType').value,
        budget,
        deadline
      });
      toast('已发布');
      switchTab('board');
    } catch (e) {
      toast('发布失败：' + (e.message || e));
    }
  }

  // ---------- 聊天 ----------
  async function openChat(reqId) {
    const list = await DB.listBoard({ status: 'all' }); // 取该需求最新快照
    const req = list.find(r => r.id === reqId) || await DB.listMine(state.uid).then(l => l.find(r => r.id === reqId));
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
    div.className = 'msg' + (me ? ' me' : '');
    const atts = Array.isArray(m.attachments) ? m.attachments : [];
    let attHtml = '';
    if (atts.length) {
      const imgs = atts.filter(a => (a.mime || '').startsWith('image/'));
      const files = atts.filter(a => !(a.mime || '').startsWith('image/'));
      if (imgs.length) {
        attHtml += `<div class="msg-media">` + imgs.map(a =>
          `<a class="msg-img-link" href="${esc(a.url)}" target="_blank" rel="noopener"><img class="msg-img" src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy" /></a>`
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
    // 拉最新需求（先大厅再我发布的再我抢的，覆盖三个来源）
    let r = (await DB.listBoard({ status: 'all' }).catch(() => [])).find(x => x.id === reqId);
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
    const budget = Number(r.budget) > 0 ? `¥${Number(r.budget).toFixed(0)}` : '面议';
    const dlStr = r.deadline ? fmtTime(r.deadline) + (new Date(r.deadline) > new Date() ? `（${countdownHtml(r.deadline).replace(/<[^>]+>/g,'')}）` : '') : '不限';
    const html = `
      <div class="drawer-meta-row">
        <div class="item"><div class="label">预算</div><div class="value">${esc(budget)}</div></div>
        <div class="item"><div class="label">截止时间</div><div class="value">${esc(dlStr)}</div></div>
        <div class="item"><div class="label">任务类型</div><div class="value">${esc(r.task_type)}</div></div>
        <div class="item"><div class="label">发布时间</div><div class="value">${esc(fmtTime(r.created_at))}</div></div>
      </div>
      <div class="drawer-section">
        <div class="label">需求描述</div>
        <div class="value">${esc(r.description || '（无描述）')}</div>
      </div>
      <div class="drawer-section">
        <div class="label">发布者</div>
        <div class="drawer-publisher">
          <span class="avatar-sm">${esc(initials(r.publisher_name))}</span>
          <div class="info">
            <div class="name">${esc(r.publisher_name || '匿名')}</div>
            <div class="stats">累计发布 ${stats.total} 单 · 已完成 ${stats.done} 单</div>
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
    // 详情底部动作按钮（与卡片同逻辑）
    const isMine = r.publisher_id === state.uid;
    const isLockedByMe = r.locked_by === state.uid;
    let acts = '';
    if (st === 'open' && !isMine) {
      acts = `<button class="btn btn-primary" data-act="grab" data-id="${r.id}">抢单</button>`;
    } else if (isMine || isLockedByMe) {
      acts = `<button class="btn btn-primary" data-act="chat" data-id="${r.id}">沟通</button>`;
      if (st === 'locked' && isLockedByMe) acts += `<button class="btn" data-act="start" data-id="${r.id}">开始设计</button>`;
      if (st === 'in_progress' && isLockedByMe) acts += `<button class="btn btn-grab" data-act="done" data-id="${r.id}">标记完成</button>`;
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
      const msg = c.last_message ? c.last_message : (c.status === 'open' ? '（等待抢单中）' : '（暂无消息）');
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
