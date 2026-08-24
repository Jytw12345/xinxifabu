/* ============================================================
 * db.js  —  设计需求发布平台 数据访问层
 * 封装 Supabase 客户端、Auth、需求/消息读写、抢单 RPC。
 * 所有函数返回 Promise；调用方负责 try/catch。
 * ============================================================ */
(function () {
  const URL = Cfg.SUPABASE_URL;
  const KEY = Cfg.SUPABASE_ANON_KEY;
  const client = window.supabase.createClient(URL, KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  // 当前登录用户的展示名：优先取工作台 designers.name（按 auth_id 关联），否则用邮箱前缀
  async function myDisplayName() {
    const uid = (await client.auth.getUser()).data.user?.id;
    if (!uid) return '';
    try {
      const { data } = await client
        .from('designers').select('name').eq('auth_id', uid).maybeSingle();
      if (data && data.name) return data.name;
    } catch (e) { /* designers 表不存在也不影响平台使用 */ }
    const email = (await client.auth.getUser()).data.user?.email || '';
    return email.split('@')[0] || '设计师';
  }

  const DB = {
    client,

    // ---------- Auth ----------
    async signUp(email, password) {
      return client.auth.signUp({ email, password });
    },
    async signIn(email, password) {
      return client.auth.signInWithPassword({ email, password });
    },
    async signOut() { return client.auth.signOut(); },
    async getSession() { return client.auth.getSession(); },
    onAuthChange(cb) { return client.auth.onAuthStateChange(cb); },

    // ---------- 需求 ----------
    // 需求大厅：支持搜索/类型/状态/排序参数
    async listBoard({ keyword = '', type = '全部', status = 'open', sort = 'newest' } = {}) {
      let q = client.from('dr_requirements').select('*').is('deleted_at', null);
      if (status !== 'all') q = q.eq('status', status);
      if (type !== '全部') q = q.eq('task_type', type);
      if (keyword && keyword.trim()) {
        const k = keyword.trim();
        q = q.or(`title.ilike.%${k}%,description.ilike.%${k}%`);
      }
      const sorts = {
        newest:     { col: 'created_at', asc: false },
        deadline:   { col: 'deadline',   asc: true  },
        budget_high:{ col: 'budget',     asc: false },
        budget_low: { col: 'budget',     asc: true  }
      };
      const s = sorts[sort] || sorts.newest;
      q = q.order(s.col, { ascending: s.asc, nullsFirst: false });
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    },
    // 我发布的
    async listMine(uid) {
      const { data, error } = await client
        .from('dr_requirements')
        .select('*')
        .eq('publisher_id', uid)
        .is('deleted_at', null)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    // 我抢的（作为锁定设计师）
    async listGrabbed(uid) {
      const { data, error } = await client
        .from('dr_requirements')
        .select('*')
        .eq('locked_by', uid)
        .is('deleted_at', null)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    async insertRequirement(row) {
      const { data, error } = await client
        .from('dr_requirements').insert(row).select().single();
      if (error) throw error;
      return data;
    },
    async softDelete(id) {
      const { error } = await client
        .from('dr_requirements').update({ deleted_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
    },

    // 发布者历史统计（详情页用）：总发单数 + 已完成数
    async getPublisherStats(uid) {
      const [all, done] = await Promise.all([
        client.from('dr_requirements').select('*', { count: 'exact', head: true })
          .eq('publisher_id', uid).is('deleted_at', null),
        client.from('dr_requirements').select('*', { count: 'exact', head: true })
          .eq('publisher_id', uid).eq('status', 'done').is('deleted_at', null)
      ]);
      return { total: all.count || 0, done: done.count || 0 };
    },
    // 大厅顶部统计：可抢单 / 我发布的（未取消）/ 我参与的进行中
    async getBoardStats(uid) {
      const [open, mine, progress] = await Promise.all([
        client.from('dr_requirements').select('*', { count: 'exact', head: true })
          .eq('status', 'open').is('deleted_at', null),
        client.from('dr_requirements').select('*', { count: 'exact', head: true })
          .eq('publisher_id', uid).not('status', 'eq', 'cancelled').is('deleted_at', null),
        client.from('dr_requirements').select('*', { count: 'exact', head: true })
          .eq('status', 'in_progress').is('deleted_at', null)
          .or(`publisher_id.eq.${uid},locked_by.eq.${uid}`)
      ]);
      return { open: open.count || 0, mine: mine.count || 0, progress: progress.count || 0 };
    },
    // 全局消息订阅（Inbox 未读刷新用）：服务端 RLS 限制只能看到我参与的会话消息
    subscribeAllMessages(cb) {
      const ch = client.channel('dr_inbox')
        .on('postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'dr_messages' },
          (payload) => cb(payload.new))
        .subscribe();
      return ch;
    },
    async listMyChats(uid) {
      const { data: reqs } = await client
        .from('dr_requirements')
        .select('id, title, publisher_id, locked_by, status, publisher_name, locked_by_name, updated_at, linked_order_id')
        .is('deleted_at', null)
        .or(`publisher_id.eq.${uid},locked_by.eq.${uid}`);
      const list = reqs || [];
      if (!list.length) return [];
      const reqIds = list.map(r => r.id);
      const { data: msgs } = await client
        .from('dr_messages')
        .select('requirement_id, sender_id, body, created_at, attachments')
        .in('requirement_id', reqIds)
        .neq('sender_id', uid)
        .order('created_at', { ascending: false });
      const lastByReq = {};
      (msgs || []).forEach(m => { if (!lastByReq[m.requirement_id]) lastByReq[m.requirement_id] = m; });
      return list.map(r => {
        // 未读：基于 localStorage 的 lastRead_<reqId>；从未读过则全部算未读
        const reqMsgs = msgs?.filter(m => m.requirement_id === r.id) || [];
        const lastRead = localStorage.getItem('lastReadAt_' + r.id);
        const unread = lastRead
          ? reqMsgs.filter(m => m.created_at > lastRead).length
          : reqMsgs.length;
        return {
          ...r,
          last_message: lastByReq[r.id]?.body
            || ((Array.isArray(lastByReq[r.id]?.attachments) && lastByReq[r.id].attachments.length) ? '[图片/文件]' : ''),
          last_message_at: lastByReq[r.id]?.created_at || null,
          unread
        };
      });
    },
    async grab(reqId, designerId, name) {
      const { data, error } = await client.rpc('dr_grab', {
        p_req: reqId, p_designer: designerId, p_name: name || ''
      });
      if (error) throw error;
      return data; // {ok:true} 或 {ok:false, msg:...}
    },
    async setStatus(reqId, uid, status) {
      const { data, error } = await client.rpc('dr_set_status', {
        p_req: reqId, p_uid: uid, p_status: status
      });
      if (error) throw error;
      return data;
    },
    // 桥接：把已抢需求落成工作台 orders 一笔订单（幂等）。{
    //   ok:true, order_no, order_id } 或 { ok:true, already:true, order_no } 或 { ok:false, msg }
    async createOrder(reqId, uid) {
      const { data, error } = await client.rpc('dr_create_order', {
        p_req: reqId, p_uid: uid
      });
      if (error) throw error;
      return data;
    },

    // ---------- 消息 ----------
    async listMessages(reqId) {
      const { data, error } = await client
        .from('dr_messages')
        .select('*')
        .eq('requirement_id', reqId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data || [];
    },
    async sendMessage(reqId, senderId, name, body, attachments = [], msgType = 'text') {
      const { data, error } = await client
        .from('dr_messages').insert({
          requirement_id: reqId, sender_id: senderId, sender_name: name,
          body, attachments, msg_type: msgType
        }).select().single();
      if (error) throw error;
      return data;
    },
    // 上传聊天附件到 Storage（路径：{需求id}/{发送者id}/{时间戳-文件名}），返回 { path, url }
    async uploadAttachment(reqId, file) {
      const { data: { user } } = await client.auth.getUser();
      const uid = user && user.id;
      if (!uid) throw new Error('未登录');
      const safeName = String(file.name || 'file').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
      const path = `${reqId}/${uid}/${Date.now()}-${safeName}`;
      const { error } = await client.storage.from('dr-attachments').upload(path, file, {
        cacheControl: '3600', upsert: false
      });
      if (error) throw error;
      const { data } = client.storage.from('dr-attachments').getPublicUrl(path);
      return { path, url: data && data.publicUrl };
    },

    // ---------- 实时订阅 ----------
    // 大厅：任何需求被抢/状态变化 → 回调（全员可见，因 SELECT 策略对所有登录用户放行）
    subscribeBoard(cb) {
      const ch = client.channel('dr_board')
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'dr_requirements' },
          (payload) => cb(payload))
        .subscribe();
      return ch;
    },
    // 聊天：某需求的新消息 → 回调（仅双方可见，RLS 约束）
    subscribeChat(reqId, cb) {
      const ch = client.channel('dr_chat_' + reqId)
        .on('postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'dr_messages',
            filter: 'requirement_id=eq.' + reqId },
          (payload) => cb(payload.new))
        .subscribe();
      return ch;
    },
    unsubscribe(ch) {
      if (ch) client.removeChannel(ch);
    },

    myDisplayName
  };

  window.DB = DB;
})();
