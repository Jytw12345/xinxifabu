/* ============================================================
 * db.js  —  设计需求发布平台 数据访问层
 * 封装 Supabase 客户端、Auth、需求/消息读写、抢单 RPC。
 * 所有函数返回 Promise；调用方负责 try/catch。
 * ============================================================ */
(function () {
  const URL = Cfg.SUPABASE_URL;
  const KEY = Cfg.SUPABASE_ANON_KEY;
  const client = window.supabase.createClient(URL, KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // 与工作台 sheji-main 对齐：统一 storageKey 让两个产品共享同一份登录态
      // （抢单平台通过 URL hash 收到 token 后 setSession 写到这里，下次启动直接复用）
      storageKey: 'ds-auth-v1'
    }
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
    // 注册时把真实姓名写入 designers 展示名；先尝试直接 upsert，失败则走兜底 RPC
    async updateDisplayName(uid, name) {
      if (!uid || !name) return { ok: false, msg: '参数缺失' };
      try {
        const { error } = await client
          .from('designers').upsert({ auth_id: uid, name: name }, { onConflict: 'auth_id' });
        if (error) throw error;
        return { ok: true };
      } catch (e) {
        // 兜底：若 designers 表 RLS 不允许直接写，用管理员级 RPC
        const { data, error } = await client.rpc('dr_update_display_name', {
          p_uid: uid, p_name: name
        });
        if (error) throw error;
        return data;
      }
    },
    async signOut() { return client.auth.signOut(); },
    async getSession() { return client.auth.getSession(); },
    // 【v540】跨产品快速登录：接收 workbench 通过 URL hash 传来的 token，写入共享 storageKey
    async setSession(accessToken, refreshToken) {
      return client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    },
    onAuthChange(cb) { return client.auth.onAuthStateChange(cb); },

    // ---------- 需求 ----------
    // 需求大厅：支持搜索/类型/状态/排序/分页；返回 { list, total }
    async listBoard({ keyword = '', type = '全部', status = 'open', sort = 'newest', limit = 30, offset = 0 } = {}) {
      let q = client.from('dr_requirements').select('*', { count: 'exact', head: false }).is('deleted_at', null);
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
      if (limit > 0) q = q.range(offset, offset + limit - 1);
      const { data, error, count } = await q;
      if (error) throw error;
      return { list: data || [], total: count || 0 };
    },
    // 按 id 取单条需求（分页后不再用 listBoard 全量捞）
    async getRequirement(id) {
      const { data, error } = await client
        .from('dr_requirements').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data;
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
    async softDelete(id, uid) {
      const { data, error } = await client.rpc('dr_withdraw', { p_req: id, p_uid: uid });
      if (error) throw error;
      if (data && !data.ok) throw new Error(data.msg || '撤回失败');
    },
    // 发布参考图/素材：保存 attachments 数组（图片 URL 列表）
    async updateRequirementAttachments(id, attachments) {
      const { data, error } = await client
        .from('dr_requirements').update({ attachments }).eq('id', id).select().single();
      if (error) throw error;
      return data;
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
        .select('requirement_id, sender_id, body, created_at, attachments, msg_type')
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
          last_message_type: lastByReq[r.id]?.msg_type || 'text',
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
    async handleCancel(reqId, uid, action) {
      const { data, error } = await client.rpc('dr_handle_cancel', {
        p_req: reqId, p_uid: uid, p_action: action
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

    // ---------- 优惠券 ----------
    // 我的券：自己名下未用的 + 公开活动券（owner_id is null 且启用且在期）
    async listMyCoupons(uid) {
      const { data, error } = await client
        .from('dr_coupons')
        .select('*')
        .or(`owner_id.eq.${uid},and(owner_id.is.null,active.eq.true)`)
        .order('created_at', { ascending: false });
      if (error) throw error;
      const now = Date.now();
      return (data || []).filter(c =>
        !c.used_at && (c.expire_at == null || new Date(c.expire_at).getTime() > now)
      );
    },
    // 计算折后价：传入预算、券码、当前用户；返回 { ok, final_amount, discount, msg }
    async calcAmount(budget, code, uid) {
      const { data, error } = await client.rpc('dr_calc_amount', {
        p_budget: Number(budget) || 0, p_code: code || '', p_uid: uid
      });
      if (error) throw error;
      return data;
    },
    // 发布需求时核销券（标记为已使用）
    async redeemCoupon(uid, code) {
      if (!code) return { ok: true, msg: '无券' };
      const { data, error } = await client.rpc('dr_redeem_coupon', {
        p_uid: uid, p_code: code
      });
      if (error) throw error;
      return data;
    },

    // ---------- 管理员 ----------
    // 当前用户是否为平台管理员（工作台 designers.is_admin）
    async isAdmin(uid) {
      try {
        const { data } = await client.rpc('dr_is_admin', { p_uid: uid });
        return !!data;
      } catch (e) { return false; }
    },
    // 管理员发券/配置：payload 同 dr_admin_upsert_coupon 入参
    async adminUpsertCoupon(uid, payload) {
      const { data, error } = await client.rpc('dr_admin_upsert_coupon', {
        p_uid: uid, p_payload: payload
      });
      if (error) throw error;
      return data;
    },
    async adminDeleteCoupon(uid, id) {
      const { data, error } = await client.rpc('dr_admin_delete_coupon', {
        p_uid: uid, p_id: id
      });
      if (error) throw error;
      return data;
    },
    async adminListCoupons(uid) {
      const { data, error } = await client.rpc('dr_admin_list_coupons', { p_uid: uid });
      if (error) throw error;
      return data;
    },

    // ---------- 自动发放规则（注册送 / 定期送，管理员在后台配置） ----------
    async adminUpsertRule(uid, payload) {
      const { data, error } = await client.rpc('dr_admin_upsert_rule', {
        p_uid: uid, p_payload: payload
      });
      if (error) throw error;
      return data;
    },
    async adminListRules(uid) {
      const { data, error } = await client.rpc('dr_admin_list_rules', { p_uid: uid });
      if (error) throw error;
      return data;
    },
    // 立即发放定期券（管理员手动点，或 pg_cron 定时调用）
    async grantPeriodicCoupons(uid) {
      const { data, error } = await client.rpc('dr_grant_periodic_coupons', { p_uid: uid });
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
    // 状态流转系统消息：sender_id 置空，msg_type='system'，聊天里按系统消息居中灰显
    async sendSystemMessage(reqId, body) {
      const { data, error } = await client
        .from('dr_messages').insert({
          requirement_id: reqId, sender_id: null, sender_name: '系统',
          body, attachments: [], msg_type: 'system'
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
