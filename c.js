// ملف مولّد من src/engine.js و src/server.js و prod/store — لا تعدّله يدويًا
/* محرك توزيع حصص الاحتياط — وحدة مستقلة عن الواجهة والتخزين.
 * دالة نقية: تأخذ بيانات القسم ليوم واحد وتعيد مسودة التوزيع والحالة الجديدة،
 * دون أي تعديل على المدخلات. لا تحتوي أي أسماء معلمين.
 */
(function (root) {
  'use strict';

  const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const DAY_NAMES = { sun: 'الأحد', mon: 'الإثنين', tue: 'الثلاثاء', wed: 'الأربعاء', thu: 'الخميس', fri: 'الجمعة', sat: 'السبت' };
  const SLOT_TYPES = { teach: 'تدريس', meeting: 'اجتماع', task: 'مهمة', work: 'عمل', fixed: 'التزام ثابت' };
  const MISSING_HEADLINE = 'غير مؤكد — أحتاج إلى معلومة إضافية قبل توزيع الاحتياط.';

  /* ترتيب الدور الدائري الثابت: المعلمون المشمولون بالدور مرتبين بالرقم، دون رئيس القسم.
     يبقى المعلم المؤرشف في الحلقة ليُحفظ موقعه، لكنه لا يُكلَّف. */
  function buildRing(teachers, headId) {
    return teachers
      .filter(t => t.inRotation && t.id !== headId && Number.isFinite(t.rotationOrder))
      .sort((a, b) => a.rotationOrder - b.rotationOrder || (a.id < b.id ? -1 : 1))
      .map(t => t.id);
  }

  /* الترتيب ابتداءً من التالي للنقطة؛ بلا نقطة يبدأ من أول معلم. */
  function circularFrom(ring, pointer) {
    if (!ring.length) return [];
    let start = 0;
    if (pointer != null) {
      const i = ring.indexOf(pointer);
      start = i < 0 ? 0 : (i + 1) % ring.length;
    }
    return ring.slice(start).concat(ring.slice(0, start));
  }

  /* الرصيد الإضافي لا يُسبّب حصصًا غير مغطاة: إن استُهلك رصيد وبقيت حصص بلا تغطية (مثل الحد اليومي)، يُعاد الحساب دون استخدام
     الرصيد لهذا اليوم، ويُعتمد ما يغطي حصصًا أكثر (ويبقى الرصيد كما هو). */
  function computeDay(input) {
    const r = computeDayInner(input);
    if (r && r.ok && r.uncovered.length && (r.consumedCredits || []).length) {
      const r2 = computeDayInner({ ...input, noCredits: true });
      if (r2 && r2.ok && r2.uncovered.length < r.uncovered.length) {
        r2.notes.push({ kind: 'info', text: 'لم يُستخدم الرصيد الإضافي في هذا التوزيع: استخدامه كان سيترك حصصًا بلا تغطية. يبقى الرصيد كما هو لمرة قادمة.' });
        return r2;
      }
    }
    return r;
  }
  function computeDayInner(input) {
    const teachers = input.teachers || [];
    const headId = input.headId || null;
    const dayKey = input.dayKey || null;
    const schedule = input.schedule || null;
    const absentIds = input.absentIds || [];
    const noAbsence = !!input.noAbsence;
    const state = input.state || null;
    // الغياب الجزئي: { teacherId: [أرقام حصص التدريس التي غاب عنها] } — بدونه يكون الغياب لليوم كاملًا
    const absentPeriods = input.absentPeriods || {};
    const partialOf = id => (Array.isArray(absentPeriods[id]) ? absentPeriods[id] : null);
    // تكليفات منفّذة فعليًا (عند تصحيح يوم معتمد): { مفتاح الحصة: { teacherId, source, kind, period, cls, absentId } }
    const locked = input.locked || {};
    // إعدادات القسم (طريقة إدارة الاحتياط): الافتراضي القائم — الدين مفعّل والدور مفعّل
    const cfg = input.settings || {};
    const debtOn = cfg.debt !== false;
    const rotOn = cfg.rotation !== false;
    // حصة احتياط واحدة كحد أقصى لكل معلم في اليوم (الدين والدور معًا) — مطفأ افتراضيًا
    const oneDaily = cfg.oneDaily === true;
    // حصص محالة إلى الإدارة (مفاتيح الحصص): تُستبعد من توزيع القسم دون أي أثر على الدين أو الدور
    const transfers = new Set((input.transfers || []).map(String));
    const externalOnly = input.externalOnly === true;
    const absName = s => (s.ext ? s.absentName : nameOf(s.absentId));

    const tById = new Map(teachers.map(t => [t.id, t]));
    const nameOf = id => (tById.get(id) ? tById.get(id).name : 'معلم غير معروف');
    const missing = [];
    const notes = [];

    // ---- التحقق من اكتمال المعلومات اللازمة ----
    if (!state || !state.confirmed) missing.push('لم تُعتمد الحالة الافتتاحية للقسم (الديون ونقطة الدور).');
    if (!headId) missing.push('لم يُحدَّد رئيس القسم من سجلات المعلمين.');
    else if (!tById.has(headId)) missing.push('رئيس القسم المحدد غير موجود في سجلات هذا القسم.');
    // الجدول المعتمد: { days, periodsByDay, teacherIds, entries } — مصدر الأيام وأرقام الحصص
    if (!schedule) missing.push('لا يوجد جدول معتمد للقسم.');
    if (!dayKey) missing.push('التاريخ غير صالح.');
    else if (schedule && !(schedule.days || []).includes(dayKey)) missing.push(`الجدول المعتمد لا يتضمن يوم ${DAY_NAMES[dayKey]}. لا يُعتبر ذلك دليلًا على عدم وجود حصص؛ اعتمد جدولًا يتضمن هذا اليوم.`);
    const inSchedule = new Set(schedule ? schedule.teacherIds || [] : []);
    if (noAbsence && absentIds.length) missing.push('تعارض: اختير «لا يوجد غياب اليوم» مع أسماء غائبين.');
    if (!noAbsence && !absentIds.length) missing.push('لم يُحدَّد الغياب بعد.');
    if (new Set(absentIds).size !== absentIds.length) missing.push('تكرر اسم معلم في قائمة الغياب.');
    for (const id of absentIds) {
      const t = tById.get(id);
      if (!t) missing.push('أحد الغائبين غير مسجل في هذا القسم.');
      else if (t.status !== 'active') missing.push(`المعلم «${t.name}» غير فعّال ولا يمكن تسجيله غائبًا.`);
      else if (schedule && !inSchedule.has(id)) missing.push(`المعلم الغائب «${t.name}» ليس له سطر في الجدول المعتمد، فلا تُعرف حصصه ولا دين غيابه.`);
    }
    const ring = buildRing(teachers, headId);
    const pointerBefore = state && state.pointer != null ? state.pointer : null;
    if (pointerBefore != null && !ring.includes(pointerBefore)) {
      missing.push(`نقطة الدور المحفوظة تشير إلى «${nameOf(pointerBefore)}» وهو خارج ترتيب الدور الحالي.`);
    }
    if (missing.length) return { ok: false, headline: MISSING_HEADLINE, missing };

    const daySched = schedule.entries.filter(e => e.day === dayKey);
    // تعارض الجدول: أكثر من خانة لنفس المعلم في نفس الحصة
    const cellSeen = new Set();
    for (const e of daySched) {
      const k = e.teacherId + '|' + e.period;
      if (cellSeen.has(k)) missing.push(`الجدول يحتوي خانتين للمعلم «${nameOf(e.teacherId)}» في الحصة ${e.period}.`);
      cellSeen.add(k);
    }

    // ---- استخراج حصص الغياب: التدريس فقط ----
    const teacherPos = new Map();
    teachers.slice().sort((a, b) => (a.rotationOrder ?? 1e9) - (b.rotationOrder ?? 1e9) || (a.id < b.id ? -1 : 1))
      .forEach((t, i) => teacherPos.set(t.id, i));
    const slots = [];
    const absentees = [];
    for (const id of absentIds) {
      const allTeach = daySched.filter(e => e.teacherId === id && e.type === 'teach');
      const part = partialOf(id);
      if (part) {
        const valid = new Set(allTeach.map(e => e.period));
        if (!part.length) missing.push(`اختر حصة واحدة على الأقل لغياب «${nameOf(id)}» الجزئي، أو اجعل غيابه لليوم كاملًا.`);
        for (const p of part) if (!valid.has(p)) missing.push(`الحصة ${p} ليست من حصص تدريس «${nameOf(id)}» في جدول اليوم.`);
      }
      const teach = part ? allTeach.filter(e => part.includes(e.period)) : allTeach;
      for (const e of teach) {
        const cls = e.cls == null ? '' : String(e.cls).trim();
        if (!cls) missing.push(`الحصة ${e.period} للمعلم «${nameOf(id)}» مسجلة تدريسًا دون تحديد الصف.`);
        slots.push({ period: e.period, cls, absentId: id });
      }
      absentees.push({ id, name: nameOf(id), periods: teach.length, partial: part ? teach.map(e => e.period).sort((x, y) => x - y) : null });
    }
    // تكليف منفّذ لحصة لم تعد ضمن الغياب بعد التصحيح: يُحفظ هو وأثره ولا يُحذف عمل فعلي
    const reqKeys = new Set(slots.map(s => s.absentId + '|' + s.period + '|' + s.cls));
    for (const [k, L] of Object.entries(locked)) {
      if (!L || !tById.has(L.teacherId)) { missing.push('أحد التكليفات المنفّذة يشير إلى معلم غير موجود في القسم.'); continue; }
      if (!reqKeys.has(k)) slots.push({ period: L.period, cls: L.cls, absentId: L.absentId, orphan: true });
    }
    if (missing.length) return { ok: false, headline: MISSING_HEADLINE, missing };
    /* حصص واردة من الإدارة (external): تُوزَّع على معلمي هذا القسم بقواعده نفسها، دون دين غياب لأحد.
       externalOnly: تُوزَّع الواردة وحدها؛ حصص غياب القسم نفسه معالجة في يومه المعتمد (ومكلَّفوها في busy). */
    if (externalOnly) slots.length = 0;
    for (const x of input.external || []) slots.push({ period: x.period, cls: x.cls == null ? '' : String(x.cls), absentId: '__ext', key: x.key, ext: true, absentName: x.absentName || '', from: x.from || null });
    const toDistribute = slots.filter(s => s.ext || !transfers.has(s.absentId + '|' + s.period + '|' + s.cls) || locked[s.absentId + '|' + s.period + '|' + s.cls]);
    /* قواعد التحويل للإدارة (للقسم كاملًا): N = كل حصص الغياب بعد التصحيح (كل حصة مستقلة، والمحالة ضمنه، دون التكليفات
       المنفّذة الخارجة عن الغياب)، T = ما يتحمله القسم قبل التحويل، M = سقف الإحالات يوميًا.
       المسموح = min(max(N − T, 0), M). قيم ناقصة = لا إحالة حتى تستكملها الإدارة (لا تُخترع قيمة).
       capKeep (تصحيح يوم معتمد فقط، بتأكيد صريح): إحالات سابقة نُفذت فعليًا تُحفظ كاستثناء تاريخي ولا تُمحى. */
    const isN = v => Number.isInteger(v) && v >= 0;
    const capOn = cfg.capOn === true;
    const capIncomplete = capOn && !(isN(cfg.cap) && isN(cfg.xferMax));
    const demandKeys = slots.filter(s => !s.orphan && !s.ext).map(s => s.absentId + '|' + s.period + '|' + s.cls);
    const xferKeys = demandKeys.filter(k => transfers.has(k) && !locked[k]);
    const capAllowed = !capOn ? null : capIncomplete ? 0 : Math.min(Math.max(0, demandKeys.length - cfg.cap), cfg.xferMax);
    const capReason = () => (!capOn ? '' : capIncomplete ? 'إعدادات التحويل للإدارة غير مكتملة (حد القسم أو سقف التحويل)؛ تستكملها الإدارة.'
      : demandKeys.length <= cfg.cap ? `لا يمكن التحويل للإدارة؛ عدد الحصص لم يتجاوز حد القسم وهو ${cfg.cap}.`
      : cfg.xferMax === 0 ? 'سقف التحويل للإدارة لهذا القسم 0؛ لا يُسمح بأي إحالة.'
      : xferKeys.length >= capAllowed ? 'تم استنفاد عدد الحصص المسموح بتحويلها للإدارة اليوم.' : '');
    let capException = 0;
    if (capOn && xferKeys.length > capAllowed) {
      const keep = new Set(input.capKeep || []);
      const kept = xferKeys.filter(k => keep.has(k));
      const fresh = xferKeys.length - kept.length;
      const freshRoom = Math.max(0, capAllowed - kept.length);
      const info = { limit: capIncomplete ? null : cfg.cap, max: capIncomplete ? null : cfg.xferMax, demand: demandKeys.length, allowed: capAllowed, transferred: xferKeys.length, excess: xferKeys.length - capAllowed, keepable: kept.length };
      if (!input.capKeep || fresh > freshRoom) {
        const why = capAllowed === 0 ? capReason().replace(/^تم استنفاد.*$/, '')
          : `المسموح بإحالته ${capAllowed} فقط (المطلوب ${demandKeys.length}، حد القسم ${cfg.cap}، سقف التحويل ${cfg.xferMax}).`;
        const ex = xferKeys.length - capAllowed;
        return { ok: false, headline: 'الإحالات إلى الإدارة أكثر من العدد المسموح.', missing: [`المحال حاليًا ${xferKeys.length}. ${why} ألغِ إحالة ${ex} ${ex === 1 ? 'حصة' : 'حصص'}${input.capKeep ? ' من الإحالات الجديدة' : ''}${kept.length && !input.capKeep ? '، أو أكّد أن الإحالات السابقة نُفذت فعليًا لتُحفظ كاستثناء تاريخي' : ''}.`], manualInvalid: true, capExceeded: info };
      }
      capException = xferKeys.length - capAllowed;
    }
    if (toDistribute.length && (debtOn || rotOn) && !ring.length) {
      return { ok: false, headline: MISSING_HEADLINE, missing: ['لا يوجد معلمون في ترتيب الدور المعتمد للقسم.'] };
    }
    if (toDistribute.length && (debtOn || rotOn)) {
      // لا يُحكم بتوفر معلم ليس له سطر في الجدول المعتمد
      const unknownAvail = ring.filter(id => tById.get(id) && tById.get(id).status === 'active' && !inSchedule.has(id));
      if (unknownAvail.length) return { ok: false, headline: MISSING_HEADLINE, missing: unknownAvail.map(id => `المعلم «${nameOf(id)}» في ترتيب الدور وليس له سطر في الجدول المعتمد، فلا يُعرف توفره. أضفه إلى الجدول أو أخرجه من الدور.`) };
    }
    slots.sort((a, b) => a.period - b.period
      || (teacherPos.get(a.absentId) ?? 1e9) - (teacherPos.get(b.absentId) ?? 1e9)
      || (a.cls < b.cls ? -1 : a.cls > b.cls ? 1 : 0));

    /* رصيد الحصص الإضافية (يُضاف يدويًا، ويظهر في خانة الدين بالسالب): كل وحدة = حصة شالها المعلم زيادة.
       دين غياب جديد يُخصم منه أولًا (−1 ثم غياب 3 حصص = دين 2). وما بقي منه = إعفاء من تكليف واحد قادم عبر الدور الطبيعي
       عندما يصل الدور فعليًا إلى صاحبه وهو متاح (لا عند تجاوزه لغياب أو انشغال أو تجاوز مؤقت أو تخطٍّ)، وحدة لكل وصول. */
    const credits = {};
    for (const [k, v] of Object.entries((state && state.extraCredits) || {})) if (Number.isInteger(v) && v > 0) credits[k] = v;
    const creditsBefore = { ...credits };
    const consumedCredits = [];
    const creditOf = id => credits[id] || 0;
    const createdCredits = [];
    const addExtra = id => { credits[id] = (credits[id] || 0) + 1; createdCredits.push(id); };
    // ---- الدين: الإضافة ----
    const prev = {};
    const add = {};
    const paid = {};
    for (const t of teachers) { prev[t.id] = Math.max(0, (state.debts && state.debts[t.id]) || 0); add[t.id] = 0; paid[t.id] = 0; }
    // رئيس القسم لا يُستثنى من إضافة دين الغياب. جدول الدين غير مفعّل: لا يُضاف دين غياب جديد (وتبقى الأرصدة كما هي)
    // الحصة المحالة إلى الإدارة لا تلغي الغياب: يُضاف دينها كالمعتاد إذا كان الدين مفعّلًا
    // externalOnly: غياب القسم محسوب مسبقًا (يوم معتمد)؛ لا يُضاف دينه مرة أخرى
    if (debtOn && !externalOnly) for (const a of absentees) add[a.id] = a.periods;
    // الحصص الزيادة تُخصم من دين الغياب الجديد
    const offset = {}; const creditOffsets = [];
    for (const t of teachers) { offset[t.id] = 0; const c = creditOf(t.id); if (c > 0 && add[t.id] > 0) { const k = Math.min(c, add[t.id]); offset[t.id] = k; credits[t.id] -= k; if (!credits[t.id]) delete credits[t.id]; creditOffsets.push({ teacherId: t.id, count: k }); } }
    const running = {};
    for (const t of teachers) running[t.id] = prev[t.id] + add[t.id] - offset[t.id];

    // ---- التوزيع ----
    const absentSet = new Set(absentIds);
    const absentAt = (tid, period) => absentSet.has(tid) && (!partialOf(tid) || partialOf(tid).includes(period));
    const assignedByPeriod = new Map(); // period -> Set(teacherId)
    let pointer = pointerBefore;                       // مؤشر الدورة الأساسية
    const pending = ((state && state.pending) || []).map(p => ({ ...p })).sort((x, y) => x.seq - y.seq); // حقوق الدور المعلقة
    // الدور المحدد يدويًا: يتقدم على الحقوق المعلقة والدورة الأساسية (بعد أولوية الدين) لتكليف واحد عن طريق الدور
    let manualNext = state && state.manualNext && ring.includes(state.manualNext) ? state.manualNext : null;
    const manualNextBefore = manualNext;
    const pendingBefore = pending.map(p => ({ ...p }));
    const skips = new Set((state && state.skips) || []);  // تخطٍّ نهائي لمرة واحدة
    // أدوار أُخذت مبكرًا (تكليف يدوي بالدور قبل موعده): يُتجاوز صاحبها مرة واحدة عند وصول الدورة إليه
    const early = ((state && state.earlyTurns) || []).slice();
    const earlyBefore = early.slice();
    const consumedEarly = [];
    const hasEarly = id => early.includes(id);
    const dropEarly = id => { const i = early.indexOf(id); if (i >= 0) early.splice(i, 1); };
    let pendingSeq = (state && state.pendingSeq) || 0;
    const date = input.date || null;
    const results = [];
    const createdPending = [];
    const consumedSkips = [];
    // التجاوزات المؤقتة لهذا التاريخ: اليوم كاملًا أو حصص محددة
    const exclusions = input.exclusions || [];
    const exMap = new Map();
    for (const x of exclusions) exMap.set(x.teacherId, x);
    const excludedAt = (tid, period) => { const x = exMap.get(tid); return !!x && (x.scope === 'day' || (x.periods || []).includes(period)); };
    const manual = input.manual || {};
    const manualErrors = [];
    // الحد اليومي: التكليفات المنفّذة فعليًا (المقفلة) تُحتسب مسبقًا لأصحابها حتى لو جاءت حصصها لاحقًا في اليوم
    const lockedBy = new Map();
    for (const [k, L] of Object.entries(locked)) if (L && L.teacherId && !transfers.has(k)) lockedBy.set(L.teacherId, (lockedBy.get(L.teacherId) || 0) + 1);
    const dayCount = new Map(); // تكليفات اليوم الفعّالة حتى الآن لكل معلم (غير المقفلة)
    // مشغولون مسبقًا في هذا التاريخ (تكليفات اليوم المعتمد للقسم، أو تكليفات من الإدارة): لا تكليف آخر في الحصة نفسها، ويُحتسبون في الحد اليومي
    const busyBy = new Map(); const busyLabel = new Map();
    for (const b of input.busy || []) {
      if (!b || !b.teacherId) continue;
      if (!assignedByPeriod.has(b.period)) assignedByPeriod.set(b.period, new Set());
      assignedByPeriod.get(b.period).add(b.teacherId);
      busyBy.set(b.teacherId, (busyBy.get(b.teacherId) || 0) + 1);
      if (b.label) busyLabel.set(b.teacherId + '|' + b.period, b.label);
    }
    const usedToday = tid => (dayCount.get(tid) || 0) + (lockedBy.get(tid) || 0) + (busyBy.get(tid) || 0);

    function unavailableReason(tid, period) {
      const t = tById.get(tid);
      if (!t || t.status !== 'active') return 'غير فعّال';
      if (tid === headId) return 'رئيس القسم';
      if (absentAt(tid, period)) return 'غائب';
      const e = daySched.find(x => x.teacherId === tid && x.period === period);
      if (e) return (SLOT_TYPES[e.type] || 'التزام') + (e.type === 'teach' && e.cls ? ` (${e.cls})` : '');
      const set = assignedByPeriod.get(period);
      if (set && set.has(tid)) return busyLabel.get(tid + '|' + period) || 'مكلّف باحتياط آخر في الحصة نفسها';
      if (oneDaily && usedToday(tid) >= 1) return 'استنفد الحد اليومي (حصة احتياط واحدة)';
      if (excludedAt(tid, period)) return 'تجاوز مؤقت';
      return null;
    }
    const slotKey = s => s.key || (s.absentId + '|' + s.period + '|' + s.cls);

    /* الاختيار التلقائي لحصة دون تعديل الحالة: الدين ← الحقوق المعلقة ← الدورة الأساسية */
    function autoPick(s, blocked, rotationOnly) {
      const avail = id => !unavailableReason(id, s.period);
      const debtors = (rotationOnly || !debtOn) ? [] : ring.filter(id => avail(id) && running[id] > 0);
      if (debtors.length) {
        const maxD = Math.max(...debtors.map(id => running[id]));
        const tied = new Set(debtors.filter(id => running[id] === maxD));
        // التعادل: الأسبق في الترتيب الدائري ابتداءً من التالي لمؤشر الدورة (الجاري أثناء المعالجة)
        return { id: circularFrom(ring, pointer).find(id => tied.has(id)), source: 'debt', kind: 'debt' };
      }
      if (!rotOn) return null; // الدور غير مفعّل: لا انتقال إلى الدور، والحصة تبقى غير مغطاة
      if (manualNext && avail(manualNext) && manualNext !== blocked) return { id: manualNext, source: 'rotation', kind: 'manualNext' };
      // المحاولة الأولى تحترم الرصيد الإضافي؛ إن لم يبق متاح غير أصحاب الرصيد يُكلَّف أحدهم دون استهلاك رصيده (لا تبقى الحصة بلا تغطية بسببه)
      return (input.noCredits ? null : rotPick(s, blocked, avail, true)) || rotPick(s, blocked, avail, false);
    }
    function rotPick(s, blocked, avail, withCredit) {
      const passed = [];
      for (const p of pending) {
        if (!ring.includes(p.teacherId) || !avail(p.teacherId) || p.teacherId === blocked) continue;
        // حق دور معلّق لصاحب رصيد إضافي متاح: يُستوفى الحق من الرصيد، ويُنتقل للتالي
        if (withCredit && creditOf(p.teacherId) > 0 && !passed.some(x => x.id === p.teacherId)) { passed.push({ id: p.teacherId, why: 'creditPending', period: s.period, cls: s.cls }); continue; }
        return { id: p.teacherId, source: 'rotation', kind: 'pending', passed };
      }
      for (const id of circularFrom(ring, pointer)) {
        const t = tById.get(id);
        if (!t || t.status !== 'active') continue;
        if (skips.has(id)) { passed.push({ id, why: 'skip' }); continue; }
        if (hasEarly(id)) { passed.push({ id, why: 'early' }); continue; }
        const r = unavailableReason(id, s.period);
        if (r) {
          // وصل الدور إلى صاحبه وهو غير متاح (غائب/مشغول/تجاوز مؤقت): يبقى الدور عنده (بلا حق معلّق)،
          // وتذهب الحصة لأول معلم بعده متاح وليس عنده رصيد، ويأخذ +1 رصيد (حصة زيادة)
          if (input.holdTurn !== false) {
            const sub = holdSub(id, s, blocked, avail, withCredit);
            return sub ? { id: sub, source: 'rotation', kind: 'hold', holder: id, holderWhy: r, passed } : null;
          }
          passed.push({ id, why: r === 'تجاوز مؤقت' ? 'excluded' : r === 'غائب' ? 'absent' : 'busy', reason: r }); continue;
        }
        if (id === blocked) { passed.push({ id, why: 'consecutive' }); continue; }
        // وصل الدور فعليًا إلى صاحب رصيد إضافي وهو متاح: يُستوفى دوره من الرصيد (وحدة واحدة)، ويُنتقل للتالي
        // وصول ثانٍ في الاختيار نفسه بعد استيفاء حقه المعلّق من الرصيد: يحتاج وحدة أخرى، وإلا يُكلَّف
        const reserved = passed.filter(x => x.id === id && (x.why === 'creditPending' || x.why === 'credit')).length;
        if (withCredit && creditOf(id) - reserved > 0) { passed.push({ id, why: 'credit', period: s.period, cls: s.cls }); continue; }
        return { id, source: 'rotation', kind: 'base', passed };
      }
      return null;
    }
    // البديل عن صاحب دور غير متاح: الأول بعده في الترتيب، متاح، ليس عليه تخطٍّ، ولا رصيد عنده (إلا إن لم يبق غيرهم)
    function holdSub(holder, s, blocked, avail, withCredit) {
      for (const id of circularFrom(ring, holder)) {
        if (id === holder) continue;
        const t = tById.get(id);
        if (!t || t.status !== 'active' || !avail(id) || id === blocked) continue;
        if (skips.has(id) || hasEarly(id)) continue;
        if (withCredit && creditOf(id) > 0) continue;
        return id;
      }
      return null;
    }
    // تطبيق اختيار «الدور المحجوز»: أثر من تجاوزهم الدور قبل صاحبه، والمؤشر يقف قبل صاحبه فيبقى هو الدور القادم
    function applyHold(pick, giveTo) {
      const i = ring.indexOf(pick.holder);
      pointer = i >= 0 ? ring[(i - 1 + ring.length) % ring.length] : pointer;
      for (const p of pick.passed) {
        if (p.why === 'credit') useCredit(p, false);
        else if (p.why === 'creditPending') useCredit(p, true);
        else if (p.why === 'skip') { skips.delete(p.id); consumedSkips.push(p.id); }
        else if (p.why === 'early') { dropEarly(p.id); consumedEarly.push(p.id); }
      }
      if (giveTo) addExtra(giveTo);
    }
    function useCredit(p, viaPending) {
      if (!creditOf(p.id)) return;
      credits[p.id] -= 1; if (!credits[p.id]) delete credits[p.id];
      consumedCredits.push({ teacherId: p.id, period: p.period, cls: p.cls, pending: !!viaPending });
      if (viaPending) { const i = pending.findIndex(x => x.teacherId === p.id); if (i >= 0) pending.splice(i, 1); }
    }
    // استهلاك الرصيد في حقوق معلقة تجاوزها اختيار حق معلّق آخر (لا مؤشر ولا تخطٍّ)
    function applyPendingPassed(pick) {
      for (const p of pick.passed || []) if (p.why === 'creditPending') useCredit(p, true);
    }
    // holdAt: الدور وصل لصاحبه فعلًا لكن الحصة أُعطيت لغيره يدويًا (دور مبكر):
    // يُطبَّق أثر من تجاوزهم الدور حتى وصوله إليه، ويقف المؤشر قبله مباشرة فيبقى هو الدور القادم
    function applyBase(pick, holdAt) {
      if (holdAt) { const i = ring.indexOf(pick.id); pointer = i >= 0 ? ring[(i - 1 + ring.length) % ring.length] : pointer; }
      else pointer = pick.id;
      for (const p of pick.passed) {
        if (p.why === 'credit') useCredit(p, false);
        else if (p.why === 'creditPending') useCredit(p, true);
        else if (p.why === 'skip') { skips.delete(p.id); consumedSkips.push(p.id); }
        else if (p.why === 'early') { dropEarly(p.id); consumedEarly.push(p.id); }
        // وصل الدور إلى معلم في تجاوز مؤقت، أو مشغول في الحصة نفسها (تدريس/اجتماع/احتياط آخر بالدين…)، وأخذه من بعده:
        // لا يضيع دوره — يُحفظ له حق معلّق واحد فقط ويأخذ أول احتياط بالدور يتوفر فيه
        // «الحق المعلّق» أُلغي (2026-11): صاحب الدور غير المتاح يبقى الدور عنده (applyHold)
      }
    }

    for (const s of slots) {
      const prevSlot = results.find(r => r.teacherId && r.cls === s.cls && r.period === s.period - 1);
      const blocked = prevSlot ? prevSlot.teacherId : null;
      // خيارات التعديل اليدوي كما هي لحظة معالجة هذه الحصة
      const options = ring.filter(id => tById.get(id) && tById.get(id).status === 'active').map(id => ({
        id, name: nameOf(id), reason: unavailableReason(id, s.period), consecutive: id === blocked,
        debt: running[id], pending: pending.some(p => p.teacherId === id)
      }));
      const auto = autoPick(s, blocked);
      const key = slotKey(s);
      const m = manual[key];
      let chosen = null, source = null, kind = null, extra = {};
      const L = locked[key];
      const isTransfer = transfers.has(key);
      if (isTransfer && L) manualErrors.push(`الحصة ${s.period} — الصف ${s.cls} نُفّذ تكليفها فعليًا، فلا يمكن إحالتها إلى الإدارة.`);
      if (isTransfer && m && m.teacherId) manualErrors.push(`الحصة ${s.period} — الصف ${s.cls} محالة إلى الإدارة ولها تعديل يدوي في الوقت نفسه. ألغِ أحدهما.`);
      if (isTransfer && !L) {
        results.push({ ...s, key, absentName: absName(s), teacherId: null, teacherName: null, source: null, kind: null, status: 'admin', options,
          message: `الحصة ${s.period} — الصف ${s.cls} محالة إلى الإدارة، ولم تُسند لمعلم من القسم.` });
        continue;
      }

      if (L) {
        // تكليف نُفّذ فعليًا: يبقى اسم المنفّذ كما هو، ويُعاد تطبيق أثره الصحيح على الدين أو الدور
        chosen = L.teacherId;
        if (absentAt(chosen, s.period)) manualErrors.push(`التكليف المنفّذ للحصة ${s.period} — الصف ${s.cls} باسم «${nameOf(chosen)}» يتعارض مع تسجيله غائبًا في الحصة نفسها.`);
        if (L.source === 'debt' && debtOn && running[chosen] > 0) { source = 'debt'; kind = 'debt'; running[chosen] -= 1; paid[chosen] += 1; }
        else if (!rotOn) {
          // مصدر التكليف المنفّذ غير مفعّل الآن: يبقى التكليف باسم منفّذه دون أي أثر على الدين أو الدور
          source = 'manual'; kind = 'manual';
          notes.push({ kind: 'info', text: `«${nameOf(chosen)}» نفّذ الحصة ${s.period} — الصف ${s.cls}؛ حُفظ التكليف دون أثر على ${debtOn ? 'الدور (غير مفعّل)' : 'الدين أو الدور (غير مفعّلين)'}.` });
        }
        else {
          source = 'rotation';
          if (L.source === 'debt') notes.push({ kind: 'warn', text: debtOn ? `«${nameOf(chosen)}» نفّذ الحصة ${s.period} — الصف ${s.cls} تسديدًا لدين لم يعد قائمًا بعد التصحيح، فاحتُسبت له بالدور.` : `«${nameOf(chosen)}» نفّذ الحصة ${s.period} — الصف ${s.cls} بالدين، وجدول الدين غير مفعّل الآن، فاحتُسبت له بالدور.` });
          const rp = autoPick(s, null, true);
          const pi = pending.findIndex(p => p.teacherId === chosen);
          if (rp && rp.kind === 'base' && rp.id === chosen) { kind = 'base'; applyBase(rp); }
          else if (rp && rp.kind === 'hold' && rp.id === chosen && L.kind === 'extra') { kind = 'extra'; applyHold(rp, chosen); extra = { holdFor: rp.holder, holdForName: nameOf(rp.holder), holdWhy: rp.holderWhy }; }
          else if (chosen === manualNext) { kind = 'manualNext'; manualNext = null; pointer = chosen; }
          else if (pi >= 0) { kind = 'pending'; pending.splice(pi, 1); }
          else if (ring.includes(chosen) && (L.kind === 'base' || L.kind === 'manualNext')) {
            // نُفّذ بالدور لكن الترتيب المصحح يسبقه بمعلمين متاحين (أُلغيت تكليفاتهم): يُحفظ لكل منهم حق دور معلّق فلا يفقد دوره
            kind = 'base';
            for (const id of circularFrom(ring, pointer)) {
              if (id === chosen) break;
              const t = tById.get(id); if (!t || t.status !== 'active') continue;
              if (skips.has(id)) { skips.delete(id); consumedSkips.push(id); continue; }
              if (hasEarly(id)) { dropEarly(id); consumedEarly.push(id); continue; }
              const r = unavailableReason(id, s.period);
              if ((r && r !== 'تجاوز مؤقت') || pending.some(x => x.teacherId === id) || id === manualNext) continue;
            }
            pointer = chosen;
          }
          else if (ring.includes(chosen)) { kind = 'extra'; addExtra(chosen); } // حصة زيادة خارج دوره: +1 رصيد (يُعفى عند وصول الدور إليه)
          else kind = 'manual';
        }
        extra = { ...extra, executed: true, orphan: !!s.orphan };
      } else if (m && m.teacherId) {
        // مصدر التكليف اليدوي يُحدَّد تلقائيًا: دين قائم وقت التكليف ← «الدين» ويُخصم 1؛ وإلا «الدور»
        const src = debtOn && running[m.teacherId] > 0 ? 'debt' : rotOn ? 'rotation' : null;
        const why = !ring.includes(m.teacherId) ? 'ليس ضمن ترتيب الدور المؤهل للاحتياط'
          : !src ? (debtOn ? 'ليس عليه دين، والدور غير مفعّل لهذا القسم' : 'لا يمكن تسجيله: الدين والدور غير مفعّلين لهذا القسم')
          : unavailableReason(m.teacherId, s.period)
          || (src === 'rotation' && m.teacherId === blocked ? 'غطّى الحصة السابقة لنفس الصف عن طريق الدور' : null);
        const bypass = !auto || auto.id !== m.teacherId || auto.source !== src;
        if (why) manualErrors.push(`التعديل اليدوي للحصة ${s.period} — الصف ${s.cls} غير صالح: «${nameOf(m.teacherId)}» ${why}.`);
        else if (bypass && !String(m.reason || '').trim()) manualErrors.push(`التعديل اليدوي للحصة ${s.period} — الصف ${s.cls} يتجاوز أولوية مستحقة ويحتاج سببًا.`);
        else {
          chosen = m.teacherId; source = src;
          const debtBefore = running[chosen];
          if (src === 'debt') { kind = 'debt'; running[chosen] -= 1; paid[chosen] += 1; } // لا يستهلك الدور ولا يسدّد حقًا معلّقًا
          else {
            const rp = autoPick(s, blocked, true);
            const pi = pending.findIndex(p => p.teacherId === chosen);
            if (rp && rp.kind === 'base' && rp.id === chosen) { kind = 'base'; applyBase(rp); }
            else if (chosen === manualNext) { kind = 'manualNext'; manualNext = null; pointer = chosen; }
            else if (pi >= 0) { kind = 'pending'; pending.splice(pi, 1); } // يسدّد حقه المعلّق
            else if (rp && rp.kind === 'hold') { kind = 'extra'; applyHold(rp, chosen); } // صاحب الدور غير متاح: يبقى الدور عنده، والمكلَّف +1 رصيد
            else {
              // حصة زيادة خارج دوره (ليس عليه دين): +1 رصيد في جدول الدين يُعفيه مرة عند وصول الدور إليه،
              // ويبقى الدور عند من وصله الدور فعلًا (صاحب الاختيار التلقائي). من عليه دين يُخصم من دينه (مصدر «الدين» أعلاه)
              kind = 'extra'; addExtra(chosen);
              if (rp && rp.kind === 'base' && rp.id !== chosen && rp.passed.length) { applyBase(rp, true); }
            }
          }
          extra = { manual: true, bypass, reason: bypass ? String(m.reason).trim() : '', autoTeacherId: auto ? auto.id : null, autoName: auto ? nameOf(auto.id) : null, autoSource: auto ? auto.source : null, debtBefore, debtAfter: running[chosen] };
        }
      }
      if (!chosen && !L && !(m && m.teacherId) && auto) {
        chosen = auto.id; source = auto.source; kind = auto.kind;
        if (kind === 'debt') { running[chosen] -= 1; paid[chosen] += 1; }
        else if (kind === 'pending') { applyPendingPassed(auto); pending.splice(pending.findIndex(p => p.teacherId === chosen), 1); }
        else if (kind === 'manualNext') { manualNext = null; pointer = chosen; } // تستمر الدورة الأساسية بعده
        else if (kind === 'hold') { kind = 'extra'; applyHold(auto, chosen); extra = { holdFor: auto.holder, holdForName: nameOf(auto.holder), holdWhy: auto.holderWhy }; }
        else applyBase(auto);
      }

      if (chosen) {
        if (!assignedByPeriod.has(s.period)) assignedByPeriod.set(s.period, new Set());
        assignedByPeriod.get(s.period).add(chosen);
        if (!L) dayCount.set(chosen, (dayCount.get(chosen) || 0) + 1);
        results.push({ ...s, key, absentName: absName(s), teacherId: chosen, teacherName: nameOf(chosen), source, kind, status: 'covered', options, ...extra });
      } else {
        const parts = ring.map(id => {
          const t = tById.get(id);
          if (!t || t.status !== 'active') return null;
          const r = unavailableReason(id, s.period);
          if (r) return `${t.name}: ${r}`;
          if (blocked === id) return `${t.name}: غطّى الحصة السابقة لنفس الصف عن طريق الدور`;
          return null;
        }).filter(Boolean);
        const capped = oneDaily && parts.some(x => /استنفد الحد اليومي/.test(x));
        // لا حق إحالة إضافي بسبب عدم توفر معلم: يوضّح سبب بقاء الحصة دون إحالة
        // عدم توفر معلم لا يمنح حق إحالة إضافي: يوضّح لماذا لا يمكن تحويل الحصة
        const capWhy = capReason() ? ' ' + capReason() : '';
        const policy = !debtOn && !rotOn ? 'الدين والدور غير مفعّلين لهذا القسم، فلا يوجد توزيع تلقائي.'
          : !rotOn ? 'لا يوجد صاحب دين متاح، والدور غير مفعّل لهذا القسم.'
          : capped ? 'المرشحون استنفدوا الحد اليومي (حصة احتياط واحدة لكل معلم) أو غير متاحين.' : null;
        results.push({
          ...s, key, absentName: absName(s), teacherId: null, teacherName: null, source: null, kind: null, status: 'uncovered', options,
          message: `لا يوجد معلم متاح لتغطية الحصة ${s.period} — الصف ${s.cls} وفق البيانات والقواعد الحالية.`,
          reason: (policy ? policy + (parts.length ? ' ' + parts.join('، ') : '') : (parts.length ? parts.join('، ') : 'لا يوجد معلمون فعّالون في ترتيب الدور.')) + capWhy
        });
      }
    }
    /* تبديل حصتين بين معلمَين بعد التوزيع: يتبادلان الحصتين فقط، ويحتفظ كل معلم بمصدر حصته (دين/دور) ونوعها،
       فلا يتغير الدين ولا مؤشر الدور ولا الحقوق عمّا لو لم يحدث التبديل (حقانية الدور محفوظة). */
    const busyAt = (tid, period) => (input.busy || []).some(b => b && b.teacherId === tid && b.period === period);
    const swapWhy = (tid, r, other) => {
      const t = tById.get(tid);
      if (!t || t.status !== 'active') return 'غير فعّال';
      if (tid === headId) return 'رئيس القسم';
      if (absentAt(tid, r.period)) return 'غائب';
      const e = daySched.find(x => x.teacherId === tid && x.period === r.period);
      if (e) return (SLOT_TYPES[e.type] || 'التزام') + (e.type === 'teach' && e.cls ? ` (${e.cls})` : '');
      if (excludedAt(tid, r.period)) return 'تجاوز مؤقت';
      if (busyAt(tid, r.period)) return busyLabel.get(tid + '|' + r.period) || 'مكلّف في الحصة نفسها';
      if (results.some(x => x !== r && x !== other && x.status === 'covered' && x.teacherId === tid && x.period === r.period)) return 'مكلّف باحتياط آخر في الحصة نفسها';
      return null;
    };
    const SWAP_F = ['teacherId', 'teacherName', 'source', 'kind', 'manual', 'bypass', 'reason', 'autoTeacherId', 'autoName', 'autoSource', 'debtBefore', 'debtAfter'];
    for (const pr of input.swaps || []) {
      const k1 = pr && pr[0], k2 = pr && pr[1];
      const r1 = results.find(x => x.key === k1), r2 = results.find(x => x.key === k2);
      if (!r1 || !r2 || k1 === k2) { manualErrors.push('يوجد تبديل لحصة لم تعد ضمن حصص الغياب أو لم تعد مغطاة.'); continue; }
      const lbl = x => `الحصة ${x.period} — الصف ${x.cls}`;
      if (r1.status !== 'covered' || r2.status !== 'covered' || !r1.teacherId || !r2.teacherId) { manualErrors.push(`تبديل ${lbl(r1)} مع ${lbl(r2)}: إحدى الحصتين لم تعد مغطاة.`); continue; }
      if (r1.teacherId === r2.teacherId) { manualErrors.push(`تبديل ${lbl(r1)} مع ${lbl(r2)}: الحصتان عند المعلم نفسه.`); continue; }
      const w1 = swapWhy(r2.teacherId, r1, r2), w2 = swapWhy(r1.teacherId, r2, r1);
      if (w1) { manualErrors.push(`لا يمكن التبديل: «${r2.teacherName}» ${w1} في ${lbl(r1)}.`); continue; }
      if (w2) { manualErrors.push(`لا يمكن التبديل: «${r1.teacherName}» ${w2} في ${lbl(r2)}.`); continue; }
      const a = {}, b = {};
      for (const f of SWAP_F) { a[f] = r1[f]; b[f] = r2[f]; delete r1[f]; delete r2[f]; }
      for (const f of SWAP_F) { if (b[f] !== undefined) r1[f] = b[f]; if (a[f] !== undefined) r2[f] = a[f]; }
      r1.swapped = true; r1.swapWith = r2.teacherName; r2.swapped = true; r2.swapWith = r1.teacherName;
    }
    // بعد التبديل: لا يغطي معلم بالدور حصتين متتاليتين لنفس الصف
    if ((input.swaps || []).length) for (const r of results) {
      if (!r.swapped || r.source !== 'rotation') continue;
      const prev = results.find(x => x.status === 'covered' && x.cls === r.cls && x.period === r.period - 1 && x.teacherId === r.teacherId);
      if (prev) manualErrors.push(`لا يمكن التبديل: «${r.teacherName}» سيغطي الحصتين ${prev.period} و${r.period} لنفس الصف ${r.cls} متتاليتين عن طريق الدور.`);
    }
    for (const k of transfers) if (!results.some(r => r.key === k)) manualErrors.push('توجد إحالة إلى الإدارة لحصة لم تعد ضمن حصص الغياب.');
    for (const k of Object.keys(manual)) if (manual[k] && manual[k].teacherId && !results.some(r => r.key === k)) manualErrors.push('يوجد تعديل يدوي لحصة لم تعد ضمن حصص الغياب.');
    if (manualErrors.length) return { ok: false, headline: 'التعديلات اليدوية تحتاج مراجعة قبل حساب المسودة.', missing: manualErrors, manualInvalid: true };

    // تنبيه: حصص متزامنة (قرار غير محسوم في التعليمات)
    const perPeriod = {};
    for (const s of slots) perPeriod[s.period] = (perPeriod[s.period] || 0) + 1;
    const simultaneous = Object.keys(perPeriod).filter(p => perPeriod[p] > 1).map(Number);
    if (simultaneous.length) {
      notes.push({
        kind: 'decision',
        text: `توجد حصص متزامنة في الحصة ${simultaneous.join('، ')}. عولجت بترتيب ثابت (رقم الحصة ثم ترتيب المعلم الغائب ثم الصف). ترتيب معالجة الحصص المتزامنة قرار لم يُحسم بعد.`
      });
    }
    for (const t of teachers) {
      if (!ring.includes(t.id) && t.id !== headId && running[t.id] > 0 && t.status === 'active') {
        notes.push({ kind: 'warn', text: `«${t.name}» لديه دين لكنه خارج ترتيب الدور، فلا يُرشَّح للتكليف.` });
      }
    }
    if (!debtOn) notes.push({ kind: 'info', text: 'جدول الدين غير مفعّل لهذا القسم: لم يُضف دين غياب ولم يُخصم دين، وبقيت الأرصدة السابقة كما هي.' });
    if (!rotOn) notes.push({ kind: 'info', text: 'الدور غير مفعّل لهذا القسم: لم يُستخدم في التوزيع، ولم يتحرك مؤشره ولم تتغير حقوقه.' });
    if (capException) notes.push({ kind: 'warn', text: `استثناء تاريخي: ${capException} ${capException === 1 ? 'إحالة' : 'إحالات'} إلى الإدارة فوق المسموح، نُفذت فعليًا قبل تصحيح الغياب وحُفظت كما حدثت.` });
    if (oneDaily) {
      notes.push({ kind: 'info', text: 'الحد اليومي مفعّل: حصة احتياط واحدة كحد أقصى لكل معلم في اليوم (الدين والدور معًا).' });
      for (const [tid, c] of lockedBy) if (c > 1) notes.push({ kind: 'warn', text: `«${nameOf(tid)}» نفّذ فعليًا ${c} حصص احتياط في هذا اليوم؛ حُفظت كما نُفّذت.` });
    }
    for (const a of absentees) {
      if (a.periods === 0) notes.push({ kind: 'info', text: `«${a.name}» مسجل غائبًا ولا يملك حصص تدريس في جدول اليوم؛ دين اليوم = 0.` });
    }

    // ---- جدول الدين ----
    const debtRows = teachers.map(t => ({
      id: t.id, name: t.name, status: t.status,
      prev: prev[t.id], add: add[t.id], paid: paid[t.id], offset: offset[t.id],
      remaining: prev[t.id] + add[t.id] - offset[t.id] - paid[t.id]
    }));
    // تكليفات منفّذة لحصص لم تعد ضمن الغياب (حُفظت مع أثرها)
    const executedOrphans = results.filter(r => r.orphan);
    const newDebts = {};
    for (const r of debtRows) newDebts[r.id] = r.remaining;

    const next = nextPriority(ring, tById, pointer, pending, skips, manualNext, early, credits);
    for (const c of creditOffsets) notes.push({ kind: 'info', text: `«${nameOf(c.teacherId)}» كان له ${c.count === 1 ? 'حصة زيادة' : c.count + ' حصص زيادة'}؛ خُصمت من دين غيابه اليوم.` });
    for (const c of consumedCredits) notes.push({ kind: 'info', text: `وصل الدور إلى «${nameOf(c.teacherId)}» في الحصة ${c.period} — الصف ${c.cls}: تم استيفاء الدور من الرصيد الإضافي (المتبقي ${creditOf(c.teacherId)}).` });
    for (const r of results) if (r.holdFor) notes.push({ kind: 'info', text: `الحصة ${r.period} — الصف ${r.cls}: صاحب الدور «${r.holdForName}» ${r.holdWhy === 'غائب' ? 'غائب' : 'غير متاح (' + r.holdWhy + ')'}، فأُعطيت لـ«${r.teacherName}» حصة زيادة (+1 رصيد)، ويبقى الدور عند «${r.holdForName}».` });
    for (const p of createdPending) notes.push({ kind: 'info', text: p.restored ? `نُفّذ تكليف بالدور بعد «${nameOf(p.teacherId)}» في الترتيب المصحح، فحُفظ له حق دور معلّق حتى لا يفقد دوره.` : p.busy ? `وصل الدور إلى «${nameOf(p.teacherId)}» وهو مشغول في الحصة نفسها (${p.busy})، فحُفظ له دوره (حق معلّق) ويأخذ أول احتياط بالدور يتوفر فيه.` : `وصل الدور إلى «${nameOf(p.teacherId)}» أثناء تجاوزه المؤقت، فحُفظ له حق دور معلّق.` });

    return {
      ok: true,
      noAbsence,
      absentees,
      slots: results,
      uncovered: results.filter(r => r.status === 'uncovered'),
      transferred: results.filter(r => r.status === 'admin'),
      settings: { debt: debtOn, rotation: rotOn, oneDaily },
      // أعداد حد القسم لهذا اليوم (تُحفظ مع اليوم المعتمد)
      cap: capOn ? { on: true, incomplete: capIncomplete, limit: capIncomplete ? (isN(cfg.cap) ? cfg.cap : null) : cfg.cap, max: isN(cfg.xferMax) ? cfg.xferMax : null, demand: demandKeys.length, allowed: capAllowed, transferred: xferKeys.length, remaining: Math.max(0, capAllowed - xferKeys.length), exception: capException, reason: capReason() || null }
        : { on: false, incomplete: false, limit: null, max: null, demand: demandKeys.length, allowed: null, transferred: xferKeys.length, remaining: null, exception: 0, reason: null },
      debtRows,
      pointerBefore,
      pointerAfter: pointer,
      pointerBeforeName: pointerBefore != null ? nameOf(pointerBefore) : null,
      pointerAfterName: pointer != null ? nameOf(pointer) : null,
      pendingBefore: pendingBefore.map(p => ({ ...p, name: nameOf(p.teacherId) })),
      pendingAfter: pending.map(p => ({ ...p, name: nameOf(p.teacherId) })),
      createdPending: createdPending.map(p => ({ teacherId: p.teacherId, seq: p.seq, since: p.since, restored: !!p.restored, name: nameOf(p.teacherId) })),
      consumedSkips,
      earlyBefore: earlyBefore.map(id => ({ teacherId: id, name: nameOf(id) })),
      earlyAfter: early.map(id => ({ teacherId: id, name: nameOf(id) })),
      createdEarly: results.filter(r => r.kind === 'early').map(r => ({ teacherId: r.teacherId, name: r.teacherName, period: r.period, cls: r.cls })),
      consumedEarly: consumedEarly.map(id => ({ teacherId: id, name: nameOf(id) })),
      // الرصيد الإضافي: قبل اليوم وبعده، وما استُهلك منه (الحصة التي أُعفي منها صاحبه)
      creditsBefore, creditsAfter: { ...credits },
      consumedCredits: consumedCredits.map(x => ({ ...x, name: nameOf(x.teacherId) })),
      creditOffsets: creditOffsets.map(x => ({ ...x, name: nameOf(x.teacherId) })),
      createdCredits: results.filter(r => r.kind === 'extra').map(r => ({ teacherId: r.teacherId, name: r.teacherName, period: r.period, cls: r.cls })),
      executedOrphans,
      exclusionsApplied: exclusions.map(x => ({ teacherId: x.teacherId, name: nameOf(x.teacherId), scope: x.scope, periods: x.periods || [] })),
      nextInRotation: next.id,
      nextInRotationName: next.id ? nameOf(next.id) : null,
      nextKind: next.kind,
      newState: { debts: newDebts, pointer, pending: pending.map(p => ({ teacherId: p.teacherId, seq: p.seq, since: p.since })), skips: Array.from(skips), pendingSeq, manualNext, earlyTurns: early.slice(), extraCredits: { ...credits } },
      manualNextBefore, manualNextName: manualNext ? nameOf(manualNext) : null,
      notes
    };
  }

  /* صاحب الأولوية التالية في الدور: أول حق معلّق لمعلم فعّال، وإلا التالي في الدورة الأساسية (مع احترام التخطي).
     ترتيب فقط؛ يخضع للتوفر وأولوية الدين وقت التوزيع. */
  function nextPriority(ring, tById, pointer, pending, skips, manualNext, earlyTurns, extraCredits) {
    const active = id => tById.get(id) && tById.get(id).status === 'active';
    const cr = id => !!(extraCredits && extraCredits[id] > 0); // صاحب الرصيد الإضافي يُعفى عند وصول الدور إليه
    if (manualNext && ring.includes(manualNext) && active(manualNext)) return { id: manualNext, kind: 'manualNext' };
    const pend = (pending || []).slice().sort((a, b) => a.seq - b.seq).filter(x => ring.includes(x.teacherId) && active(x.teacherId));
    const p = pend.find(x => !cr(x.teacherId));
    if (p) return { id: p.teacherId, kind: 'pending' };
    const sk = new Set(skips instanceof Set ? Array.from(skips) : (skips || []));
    for (const id of earlyTurns || []) sk.add(id); // صاحب الدور المبكر يُتجاوز عند وصول الدورة إليه
    const id = circularFrom(ring, pointer).find(x => active(x) && !sk.has(x) && !cr(x)) || circularFrom(ring, pointer).find(x => active(x) && !sk.has(x));
    return { id: id || null, kind: id ? 'base' : null };
  }

  /* كم دورًا قبل المعلم: محاكاة اختيارات الدور القادمة (المحدد يدويًا، ثم الحقوق المعلقة، ثم الدورة الأساسية مع التخطي
     والرصيد الإضافي وحدة لكل وصول) حتى يصل إليه. ترتيب فقط: لا يعرف الغياب والانشغال وأولوية الدين وقت التوزيع. */
  function turnsAhead(ring, tById, state, tid) {
    const active = id => tById.get(id) && tById.get(id).status === 'active';
    const act = ring.filter(active);
    if (!act.includes(tid)) return { inRing: false, ringSize: act.length };
    const st = state || {};
    let manualNext = st.manualNext && act.includes(st.manualNext) ? st.manualNext : null;
    const pending = (st.pending || []).slice().sort((a, b) => a.seq - b.seq).map(p => p.teacherId).filter(id => act.includes(id));
    const skips = new Set(st.skips || []);
    const early = (st.earlyTurns || []).slice();
    const credits = {}; for (const [k, v] of Object.entries(st.extraCredits || {})) if (Number.isInteger(v) && v > 0) credits[k] = v;
    let pointer = st.pointer || null, ahead = 0;
    for (let guard = 0; guard < 2000; guard++) {
      let pick = null;
      if (manualNext) { pick = manualNext; manualNext = null; }
      else {
        while (pending.length && !pick) {
          const id = pending.shift();
          if (credits[id] > 0) { credits[id] -= 1; continue; }
          pick = id;
        }
        if (!pick) {
          for (const id of circularFrom(ring, pointer)) {
            if (!active(id)) continue;
            if (skips.has(id)) { skips.delete(id); continue; }
            const e = early.indexOf(id); if (e >= 0) { early.splice(e, 1); continue; }
            if (credits[id] > 0) { credits[id] -= 1; continue; }
            pick = id; pointer = id; break;
          }
        }
      }
      if (!pick) break;
      if (pick === tid) return { inRing: true, ringSize: act.length, ahead };
      ahead++;
    }
    return { inRing: true, ringSize: act.length, ahead: null };
  }

  /* مفتاح اليوم الدراسي من تاريخ بصيغة YYYY-MM-DD */
  function dayKeyOf(dateStr) {
    const d = new Date(dateStr + 'T12:00:00Z');
    if (isNaN(d)) return null;
    return DAY_KEYS[d.getUTCDay()];
  }

  const Engine = { computeDay, buildRing, circularFrom, nextPriority, turnsAhead, dayKeyOf, DAY_KEYS, DAY_NAMES, SLOT_TYPES, MISSING_HEADLINE };
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  root.Engine = Engine;
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* محرك جدول المدرسة (من أداة «جدول المدرسة الأسبوعي» الإصدار 15). يُستخدم في الأداة داخل الموقع وفي الخادم للتحقق قبل التفعيل.
   منذ «إعدادات وقوانين الجدول»: الفرص والمزدوجة والمرافق وتعريف الحصص الأولى والأخيرة وحدودها والاجتماعات والمناهج إعدادات محفوظة لكل مدرسة
   (normRc/schoolWithSettings/effectiveRules) لا قيم ثابتة؛ والقيم الافتراضية للإعدادات غير المضبوطة فقط. */
/* محرك جدولة المدرسة — يعمل في المتصفح وفي Node.
   التمثيل: لكل شعبة شبكة من (الأيام × الحصص) كلها مشغولة بدروس الشعبة.
   الدرس المفرد يشغل خانة واحدة، والمزدوج خانتين متتاليتين لا تعبرهما فرصة. */
(function (root) {
  'use strict';

  function rng(seed) {
    let a = seed >>> 0 || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- بناء النموذج من البيانات ----------
  function buildModel(school) {
    const D = school.days.length, P = school.periods, S = D * P;
    const breaks = new Set(school.breaks || []);        // فرصة بعد هذه الحصص
    const subj = school.subjects.map((s, i) => ({ ...s, idx: i }));
    const subjIdx = {}; subj.forEach(s => subjIdx[s.name] = s.idx);
    const secs = school.sections.slice();
    const secIdx = {}; secs.forEach((s, i) => secIdx[s] = i);
    const T = school.teachers.map((t, i) => ({ ...t, idx: i, subj: subjIdx[t.dept] }));
    const problems = [];

    // حصص البداية المسموحة للمزدوج: p و p+1 داخل اليوم، ولا فرصة بينهما (إلا إذا سمحت الإعدادات بعبور الفرص)
    const crossOk = !!school.doubleCrossBreak;
    const dblStartP = [];
    for (let p = 1; p < P; p++) if (crossOk || !breaks.has(p)) dblStartP.push(p);

    const lessons = [];       // {sec, subj, teachers:[], len}
    const secLessons = secs.map(() => []);
    // جدول جاهز (مستورد من Excel كما هو): الدروس محددة صراحة بالشعبة والمادة والمعلمين، فلا تُشتق من الأنصبة
    // ولا يُشترط اكتمال حصص الشعبة. الشعب = المستخدمة في الدروس فقط.
    const explicit = Array.isArray(school.lessons);
    if (explicit) {
      secs.length = 0; for (const k in secIdx) delete secIdx[k]; secLessons.length = 0;
      const order = school.sections.slice();
      for (const x of school.lessons) if (!order.includes(String(x.sec))) order.push(String(x.sec));
      const used = new Set(school.lessons.map(x => String(x.sec)));
      order.filter(v => used.has(v)).forEach((v, i) => { secs.push(v); secIdx[v] = i; secLessons.push([]); });
      const tIdx = {}; T.forEach(t => { if (t.id != null) tIdx[String(t.id)] = t.idx; });
      const pa = school.prac && school.prac.assign ? school.prac.assign : null;
      school.lessons.forEach((x, i) => {
        // إسناد مجموعات الدراسات العملية للفصل الدراسي (من الإعدادات) يحل محل معلمي الدرس المستورد لهذه الشعبة
        if (pa && x.subj === school.prac.subj && Array.isArray(pa[String(x.sec)]) && pa[String(x.sec)].length) x = Object.assign({}, x, { t: pa[String(x.sec)] });
        let j = subjIdx[x.subj];
        if (j == null) { problems.push(`الدرس ${i + 1}: المادة «${x.subj}» غير موجودة في إعدادات الجدول`); j = 0; }
        const ts = [];
        for (const id of x.t || []) { const k = tIdx[String(id)]; if (k == null) problems.push(`الدرس ${i + 1}: معلم غير موجود في قائمة المعلمين الحالية`); else ts.push(k); }
        const si = secIdx[String(x.sec)];
        const id = lessons.length; lessons.push({ id, sec: si, subj: j, teachers: ts, len: x.len === 2 ? 2 : 1 }); secLessons[si].push(id);
      });
    }
    for (let si = 0; si < secs.length && !explicit; si++) {
      const pa = school.prac && school.prac.assign ? school.prac.assign : null, tById = {}; T.forEach(t => { if (t.id != null) tById[String(t.id)] = t.idx; });
      for (const s of subj) {
        let ts = T.filter(t => t.subj === s.idx && (t.secs || []).includes(secs[si])).map(t => t.idx);
        if (pa && s.name === school.prac.subj && Array.isArray(pa[secs[si]]) && pa[secs[si]].length) ts = pa[secs[si]].map(id => tById[String(id)]).filter(v => v != null);
        if (s.load === 0) continue;
        if (!ts.length && !school.allowMissing) problems.push(`الشعبة ${secs[si]}: لا يوجد معلم مسند لمادة ${s.name}`);
        if (!s.double && ts.length > 1 && !(school.prac && s.name === school.prac.subj)) problems.push(`الشعبة ${secs[si]}: مادة ${s.name} مسندة إلى ${ts.length} معلمين`);
        if (s.double) {
          if (s.load % 2) { problems.push(`نصاب ${s.name} (${s.load}) فردي ولا يمكن تقسيمه إلى حصص مزدوجة`); continue; }
          for (let k = 0; k < s.load / 2; k++) { const id = lessons.length; lessons.push({ id, sec: si, subj: s.idx, teachers: ts, len: 2 }); secLessons[si].push(id); }
        } else {
          for (let k = 0; k < s.load; k++) { const id = lessons.length; lessons.push({ id, sec: si, subj: s.idx, teachers: ts, len: 1 }); secLessons[si].push(id); }
        }
      }
      const tot = secLessons[si].reduce((a, l) => a + lessons[l].len, 0);
      if (tot !== S) problems.push(`الشعبة ${secs[si]}: مجموع الأنصبة ${tot} لا يساوي عدد الحصص الأسبوعية ${S}`);
    }

    // الاجتماعات: ثابتة من البيانات، أو متغيرة يختارها المحرك
    const meetFixed = subj.map(s => (school.meetings[s.name] || []).map(([d, p]) => d * P + (p - 1)));
    const meetVar = subj.map(s => !(school.meetings[s.name] || []).length && !(school.noMeeting || []).includes(s.name));
    const deptTeachers = subj.map(s => T.filter(t => t.subj === s.idx).map(t => t.idx));
    // آخر حصة فعلية في كل يوم (dayPeriods اختياري لعدد حصص مختلف بين الأيام)
    const dayLen = Array.isArray(school.dayPeriods) && school.dayPeriods.length === D ? school.dayPeriods.map(n => Math.max(1, Math.min(P, n))) : school.days.map(() => P);
    // تعريف الحصص الأولى والأخيرة: الافتراضي أول وآخر حصة دراسية فعلية في كل يوم، أو حصص يحددها المستخدم لكل يوم.
    // التعريف نفسه في العدادات (F وL) والحدود والإعفاء من الحصة الأخيرة.
    const fl = school.firstLast && school.firstLast.mode === 'custom' ? school.firstLast : null;
    const pick = (obj, d, dflt) => { const a = obj && Array.isArray(obj[d]) ? obj[d].map(Number).filter(p => Number.isInteger(p) && p >= 1 && p <= dayLen[d]) : []; return a.length ? [...new Set(a)].sort((x, y) => x - y) : dflt; };
    const firstSlots = [], lastSlots = [];
    for (let d = 0; d < D; d++) { pick(fl && fl.first, d, [1]).forEach(p => firstSlots.push(d * P + p - 1)); pick(fl && fl.last, d, [dayLen[d]]).forEach(p => lastSlots.push(d * P + p - 1)); }
    // المرافق: سعة كل مرفق (عدد الشعب في الحصة نفسها على مستوى المدرسة) ومواده المشتركة. بلا إعداد: من سعة المواد في الإعدادات
    let facs;
    if (Array.isArray(school.facilities)) facs = school.facilities.map(f => Object.assign({ name: String(f.name || 'مرفق'), cap: f.on === false ? 0 : Math.max(0, f.cap | 0), subjects: (f.subjects || []).filter(n => subjIdx[n] != null), msg: f.msg || '' }, f.spec ? { spec: f.spec } : {})).filter(f => f.subjects.length);
    else { facs = []; subj.forEach(s => { if (s.cap) facs.push({ name: s.facility || s.name, cap: s.cap, subjects: [s.name], msg: s.capMsg || '' }); }); }
    const subjFac = subj.map(s => facs.findIndex(f => f.subjects.includes(s.name) && !f.spec));
    // الدراسات العملية: تخصص الدرس من منهج صف الشعبة في الفصل الدراسي، والورش من مرفق التخصص نفسه فقط،
    // وعدد الورش التي يشغلها الدرس = عدد المجموعات (معلم لكل مجموعة) عند اعتماد تقسيم الشعبة
    const prac = school.prac && subjIdx[school.prac.subj] != null ? school.prac : null, pj = prac ? subjIdx[prac.subj] : -1;
    lessons.forEach(L => {
      L.fac = subjFac[L.subj]; L.fw = 1; L.spec = null;
      if (L.subj !== pj) return;
      L.spec = (prac.curr || {})[gradeOfSec(secs[L.sec])] || null;
      const f = L.spec ? facs.findIndex(F => F.subjects.includes(prac.subj) && F.spec === L.spec) : -1;
      if (f >= 0) L.fac = f; else if (facs.some(F => F.spec)) L.fac = -1;
      if (prac.split) L.fw = Math.max(1, L.teachers.length);
    });
    const tLessons = T.map(() => []); lessons.forEach((L, l) => L.teachers.forEach(t => tLessons[t].push(l)));
    return { school, D, P, S, dayLen, firstSlots, lastSlots, breaks, dblStartP, crossOk, subj, subjIdx, secs, secIdx, T, lessons, secLessons, tLessons, meetFixed, meetVar, deptTeachers, facs, subjFac, problems, explicit };
  }

  // ---------- الحالة ----------
  function createState(M) {
    const { S, T, subj, secs, lessons } = M;
    return {
      M,
      grid: new Int32Array(secs.length * S).fill(-1),
      pos: new Int32Array(lessons.length).fill(-1),
      occ: new Int16Array(T.length * S),
      capc: new Int16Array(Math.max(1, M.facs.length) * S), // إشغال كل مرفق في كل حصة
      // إعدادات القوانين المطبقة (الحالة الافتراضية = السلوك السابق): حدود F/L لكل معلم، عبور الفرص، الاجتماعات، اجتماع الإدارة، المناهج
      rc: { fl: null, sameBreak: true, deptBlock: true, deptReq: true, adminSlots: [], adminT: [], curr: null },
      meet: subj.map((s, j) => M.meetFixed[j].slice()), // خانات اجتماع كل قسم
      blocked: new Uint8Array(T.length * S),
      pinned: new Uint8Array(lessons.length),
      unavail: T.map(() => new Set()),   // قيود دائمة على توفر المعلمين
      temp: T.map(() => new Set()),      // قيود مؤقتة أثناء البحث عن حل لطلب
      rules: subj.map(() => []),         // قوانين الجدول المعتمدة لكل مادة: {max, maxDaysOver, secs:Set, name}
      tLast: new Uint8Array(M.P),        // الحصص الأخيرة المحددة (فهرس الحصة من 0)
      tMode: new Uint8Array(subj.length), // توقيت كل مادة: 0 بلا قيد، 1 منع الحصص الأخيرة، 2 تقليلها
      anchor: null, anchorW: 0,
      exempt: new Uint8Array(T.length),  // معلمون معفون من الحصة الأخيرة في كل يوم          // للإصلاح بأقل تغيير: كلفة لكل حصة تبتعد عن موضعها الأصلي
    };
  }
  function rebuildBlocked(st) {
    const { M } = st; st.blocked.fill(0);
    if (st.rc.deptBlock) for (let j = 0; j < M.subj.length; j++) for (const s of st.meet[j]) for (const t of M.deptTeachers[j]) st.blocked[t * M.S + s] = 1;
    for (const t of st.rc.adminT) for (const s of st.rc.adminSlots) if (t >= 0 && t < M.T.length && s >= 0 && s < M.S) st.blocked[t * M.S + s] = 1;
    for (let t = 0; t < M.T.length; t++) { for (const s of st.unavail[t]) st.blocked[t * M.S + s] = 1; for (const s of st.temp[t]) st.blocked[t * M.S + s] = 1; if (st.exempt[t]) for (const s of M.lastSlots) st.blocked[t * M.S + s] = 1; }
  }
  // الإعفاء من الحصة الأخيرة: شرط إلزامي يمنع تدريس المعلم في آخر حصة من كل يوم (ويشمل الحصة المزدوجة التي تغطيها)
  function setExempt(st, list) { st.exempt.fill(0); (list || []).forEach(t => { if (t >= 0 && t < st.exempt.length) st.exempt[t] = 1; }); rebuildBlocked(st); }
  /* إعدادات القوانين على الحالة: rc = { fl: [{minF,maxF,minL,maxL}|null لكل معلم] أو null، sameBreak، deptBlock، deptReq،
     adminSlots: [خانة...]، adminT: [معلم...]، curr: [حد المناهج|null لكل معلم] أو null } */
  function setRuleConfig(st, rc) {
    rc = rc || {};
    const okT = t => Number.isInteger(t) && t >= 0 && t < st.M.T.length;
    st.rc = { fl: Array.isArray(rc.fl) && rc.fl.some(Boolean) ? rc.fl.slice() : null, sameBreak: rc.sameBreak !== false, deptBlock: rc.deptBlock !== false, deptReq: rc.deptReq !== false,
      adminSlots: (rc.adminSlots || []).filter(s => Number.isInteger(s) && s >= 0 && s < st.M.S), adminT: (rc.adminT || []).filter(okT), curr: Array.isArray(rc.curr) && rc.curr.some(v => v != null) ? rc.curr.slice() : null };
    rebuildBlocked(st);
  }
  // عدد الحصص الأولى والأخيرة للمعلم أسبوعيًا: خانات تدريس فقط (لا الاجتماعات ولا الفراغ)، والمزدوجة تُحسب إن شملت خانة من التعريف
  function flCount(st, t) {
    const { M } = st, b = t * M.S; let F = 0, L = 0;
    for (const s of M.firstSlots) if (st.occ[b + s] > 0) F++;
    for (const s of M.lastSlots) if (st.occ[b + s] > 0) L++;
    return { F, L };
  }
  function flCounts(st) { return st.M.T.map((_, t) => flCount(st, t)); }
  function flTerm(st, t) {
    const lim = st.rc.fl && st.rc.fl[t]; if (!lim) return 0;
    const c = flCount(st, t); let v = 0;
    if (lim.minF != null && c.F < lim.minF) v += lim.minF - c.F;
    if (lim.maxF != null && c.F > lim.maxF) v += c.F - lim.maxF;
    if (lim.minL != null && c.L < lim.minL) v += lim.minL - c.L;
    if (lim.maxL != null && c.L > lim.maxL) v += c.L - lim.maxL;
    return v;
  }
  /* مجموعات درس الدراسات العملية وورشها في موضعه الحالي: الورش تُرقَّم داخل مرفق التخصص على مستوى المدرسة في الحصة نفسها
     (بترتيب الشعب)، فمجموعة لا تجد ورشة شاغرة في تخصصها تظهر «بلا ورشة» ولا تُحتسب لها ورشة من التخصص الآخر */
  function pracGroups(st, l) {
    const { M } = st, L = M.lessons[l]; if (!L) return [];
    const F = L.fac >= 0 ? M.facs[L.fac] : null, s = st.pos[l], ts = L.teachers.length ? L.teachers : [-1];
    const n = L.fw > 1 ? L.fw : 1, out = [];
    let base = 0;
    if (F && s >= 0) for (let sec = 0; sec < L.sec; sec++) { const o = st.grid[sec * M.S + s]; if (o >= 0 && o !== l && M.lessons[o].fac === L.fac) base += M.lessons[o].fw; }
    for (let k = 0; k < n; k++) {
      const no = base + k + 1, t = n > 1 ? ts[k] : null;
      out.push({ t: t != null && t >= 0 ? t : null, teachers: n > 1 ? [ts[k]].filter(x => x >= 0) : L.teachers.slice(), ws: !F ? null : (F.cap && no > F.cap ? null : no), wsName: F ? (F.cap && no > F.cap ? `بلا ورشة شاغرة (${F.name} ${F.cap})` : `${F.name.replace(/^ورش /, 'ورشة ')} ${no}`) : null, spec: L.spec });
    }
    return out;
  }
  // مناهج المعلم: مادة × صف (عدة شعب للمادة والصف نفسيهما منهج واحد)، من الشعب المسندة إليه فعلًا في دروس الجدول
  const gradeOfSec = (sec) => String(sec).split('-')[0];
  function teacherCurricula(M, t) {
    const by = new Map();
    for (const l of M.tLessons[t]) { const L = M.lessons[l], g = gradeOfSec(M.secs[L.sec]), k = L.subj + '|' + g; if (!by.has(k)) by.set(k, { subj: M.subj[L.subj].name, grade: g, secs: [] }); const x = by.get(k); if (!x.secs.includes(M.secs[L.sec])) x.secs.push(M.secs[L.sec]); }
    return [...by.values()].sort((a, b) => a.subj.localeCompare(b.subj, 'ar') || a.grade.localeCompare(b.grade));
  }
  // قوانين الجدول: [{subj: اسم المادة, grades: ['8'] أو [] للكل, sections: ['8-2'] أو [] للكل, max, maxDaysOver, name}]
  function setRules(st, rules) {
    const { M } = st; st.rules = M.subj.map(() => []);
    (rules || []).forEach(r => {
      const j = M.subjIdx[r.subj]; if (j == null) return;
      const secs = new Set();
      M.secs.forEach((s, i) => { const g = s.split('-')[0]; if ((!r.grades || !r.grades.length || r.grades.includes(g)) && (!r.sections || !r.sections.length || r.sections.includes(s))) secs.add(i); });
      st.rules[j].push({ max: r.max, maxDaysOver: r.maxDaysOver == null ? null : r.maxDaysOver, secs, name: r.name || '' });
    });
  }
  // توقيت المواد: {last: [6, 7] أرقام الحصص الأخيرة، subjects: {اسم المادة: 'ban' | 'reduce'}}
  function setTiming(st, timing) {
    const { M } = st; st.tLast.fill(0); st.tMode.fill(0);
    const last = (timing && timing.last) || [];
    last.forEach(p => { if (p >= 1 && p <= M.P) st.tLast[p - 1] = 1; });
    if (!last.length) return;
    const subs = (timing && timing.subjects) || {};
    for (const name in subs) { const j = M.subjIdx[name]; if (j == null) continue; st.tMode[j] = subs[name] === 'ban' ? 1 : subs[name] === 'reduce' ? 2 : 0; }
  }
  function getTiming(st) { const { M } = st, last = [], subjects = {}; st.tLast.forEach((v, i) => v && last.push(i + 1)); st.tMode.forEach((m, j) => { if (m) subjects[M.subj[j].name] = m === 1 ? 'ban' : 'reduce'; }); return { last, subjects }; }
  function lastCount(st, l) {
    const { M } = st, s = st.pos[l]; if (s < 0) return 0;
    let n = 0; for (let k = 0; k < M.lessons[l].len; k++) if (st.tLast[(s + k) % M.P]) n++;
    return n;
  }
  function lateHard(st, l) { return st.tMode[st.M.lessons[l].subj] === 1 ? lastCount(st, l) : 0; }
  function lateSoft(st, l) {
    let v = st.tMode[st.M.lessons[l].subj] === 2 ? lastCount(st, l) : 0;
    if (st.anchor && st.pos[l] !== st.anchor[l]) v += st.anchorW;
    return v;
  }
  function secDayCounts(st, sec, d) {
    const { M } = st, base = sec * M.S + d * M.P, c = {};
    for (let p = 0; p < M.P; p++) { const l = st.grid[base + p]; if (l < 0) continue; const j = M.lessons[l].subj; c[j] = (c[j] || 0) + 1; }
    return c;
  }
  function ruleDayHard(st, sec, d) {
    let h = 0; const c = secDayCounts(st, sec, d);
    for (const j in c) for (const r of st.rules[j]) if (r.secs.has(sec) && c[j] > r.max) h += c[j] - r.max;
    return h;
  }
  function ruleWeekHard(st, sec) {
    const { M } = st; let h = 0, cs = null;
    for (let j = 0; j < M.subj.length; j++) for (const r of st.rules[j]) {
      if (r.maxDaysOver == null || !r.secs.has(sec)) continue;
      if (!cs) cs = Array.from({ length: M.D }, (_, d) => secDayCounts(st, sec, d));
      const n = cs.filter(c => (c[j] || 0) > 1).length; if (n > r.maxDaysOver) h += n - r.maxDaysOver;
    }
    return h;
  }
  function unavailList(st) { const a = []; st.unavail.forEach((set, t) => { if (set.size) a.push([t, [...set].sort((x, y) => x - y)]); }); return a; }
  function setUnavail(st, list) { st.unavail.forEach(s => s.clear()); (list || []).forEach(([t, ss]) => { if (st.unavail[t]) ss.forEach(s => st.unavail[t].add(s)); }); rebuildBlocked(st); }
  function place(st, l, start) {
    const { M } = st, L = M.lessons[l];
    st.pos[l] = start;
    for (let k = 0; k < L.len; k++) {
      const s = start + k;
      st.grid[L.sec * M.S + s] = l;
      for (const t of L.teachers) st.occ[t * M.S + s]++;
      if (L.fac >= 0) st.capc[L.fac * M.S + s] += L.fw;
    }
  }
  function unplace(st, l) {
    const { M } = st, L = M.lessons[l], start = st.pos[l];
    if (start < 0) return;
    for (let k = 0; k < L.len; k++) {
      const s = start + k;
      if (st.grid[L.sec * M.S + s] === l) st.grid[L.sec * M.S + s] = -1;
      for (const t of L.teachers) st.occ[t * M.S + s]--;
      if (L.fac >= 0) st.capc[L.fac * M.S + s] -= L.fw;
    }
    st.pos[l] = -1;
  }
  function validDblStart(M, s) { const p = (s % M.P) + 1; return M.dblStartP.includes(p); }

  // ---------- دوال التكلفة ----------
  const W_HARD = 10;
  function tTerm(st, t, s) {
    const o = st.occ[t * st.M.S + s];
    return (o > 1 ? o - 1 : 0) + (st.blocked[t * st.M.S + s] ? o : 0);
  }
  function capTerm(st, f, s) {
    if (f < 0) return 0; const c = st.M.facs[f].cap; if (!c) return 0;
    const v = st.capc[f * st.M.S + s]; return v > c ? v - c : 0;
  }
  // عبور الفرصة لمادة واحدة في حصتين متتاليتين + توزيع المادة على الأيام
  function secDayTerms(st, sec, d) {
    const { M } = st, base = sec * M.S + d * M.P;
    let hard = 0, soft = 0;
    if (st.rc.sameBreak) for (const b of M.breaks) {
      if (b >= M.P) continue;
      const a = st.grid[base + b - 1], c = st.grid[base + b];
      if (a >= 0 && c >= 0 && a !== c && M.lessons[a].subj === M.lessons[c].subj) hard++;
    }
    const cnt = {};
    for (let p = 0; p < M.P; p++) {
      const l = st.grid[base + p]; if (l < 0) continue;
      const L = M.lessons[l]; if (L.len === 2) continue;
      cnt[L.subj] = (cnt[L.subj] || 0) + 1;
    }
    for (const k in cnt) { const c = cnt[k]; if (c > 1) soft += (c - 1) * 2 + (c > 2 ? (c - 2) * 6 : 0); }
    hard += ruleDayHard(st, sec, d);
    return { hard, soft };
  }
  // الاجتماع المتغير: يجب ألا يدرّس أي معلم من القسم فيه — يُحسب ضمن tTerm عبر blocked

  function fullCost(st) {
    const { M } = st; let hard = 0, soft = 0;
    for (let t = 0; t < M.T.length; t++) for (let s = 0; s < M.S; s++) hard += tTerm(st, t, s);
    for (let f = 0; f < M.facs.length; f++) for (let s = 0; s < M.S; s++) hard += capTerm(st, f, s);
    if (st.rc.fl) for (let t = 0; t < M.T.length; t++) hard += flTerm(st, t);
    for (let sec = 0; sec < M.secs.length; sec++) for (let d = 0; d < M.D; d++) { const r = secDayTerms(st, sec, d); hard += r.hard; soft += r.soft; }
    for (let l = 0; l < M.lessons.length; l++) if (st.pos[l] >= 0) { hard += lateHard(st, l); soft += lateSoft(st, l); }
    for (let sec = 0; sec < M.secs.length; sec++) hard += ruleWeekHard(st, sec);
    return { hard, soft, total: hard * W_HARD + soft };
  }

  // تكلفة مجموعة مفاتيح متأثرة
  function localCost(st, ctx) {
    let h = 0, s = 0;
    for (const k of ctx.tk) h += tTerm(st, k >> 8, k & 255);
    for (const k of ctx.ck) h += capTerm(st, k >> 8, k & 255);
    for (const k of ctx.dk) { const r = secDayTerms(st, k >> 8, k & 255); h += r.hard; s += r.soft; }
    if (ctx.sk) for (const sec of ctx.sk) h += ruleWeekHard(st, sec);
    if (ctx.ts && st.rc.fl) for (const t of ctx.ts) h += flTerm(st, t);
    for (const l of ctx.ls) { h += lateHard(st, l); s += lateSoft(st, l); }
    return h * W_HARD + s;
  }
  function ctxFor(st, ls, slotsByLesson) {
    const { M } = st; const tk = new Set(), ck = new Set(), dk = new Set(), sk = new Set(), ts = new Set();
    for (let i = 0; i < ls.length; i++) {
      const L = M.lessons[ls[i]], f = L.fac;
      for (const t of L.teachers) ts.add(t);
      for (const s of slotsByLesson[i]) {
        for (const t of L.teachers) tk.add((t << 8) | s);
        if (f >= 0) ck.add((f << 8) | s);
        dk.add((L.sec << 8) | Math.floor(s / M.P));
        sk.add(L.sec);
      }
    }
    return { tk, ck, dk, sk, ls, ts };
  }
  function slotsOf(st, l, start) { const n = st.M.lessons[l].len; const a = []; for (let k = 0; k < n; k++) a.push(start + k); return a; }

  // ---------- الحركات ----------
  // ترجع قائمة [lesson, newStart] أو null
  function proposeMove(st, R, l) {
    const { M } = st, L = M.lessons[l], sec = L.sec, base = sec * M.S;
    if (st.pinned[l]) return null;
    const cur = st.pos[l];
    if (L.len === 1) {
      const s2 = Math.floor(R() * M.S); if (s2 === cur) return null;
      const o = st.grid[base + s2];
      if (o < 0) return M.explicit ? [[l, s2]] : null; // الجدول الجاهز قد يتضمن حصصًا فارغة للشعبة
      if (st.pinned[o]) return null;
      const O = M.lessons[o];
      if (O.len === 1) return [[l, s2], [o, cur]];
      // تبادل مفرد مع مزدوج: انقل المزدوج ليغطي خانة هذا المفرد
      return doubleMoveTo(st, R, o, null, cur);
    }
    return doubleMoveTo(st, R, l, null, -1);
  }
  // نقل درس مزدوج إلى بداية جديدة (عشوائية، أو تغطي خانة معينة)
  function doubleMoveTo(st, R, l, ignore, mustCover) {
    const { M } = st, L = M.lessons[l], base = L.sec * M.S, cur = st.pos[l];
    let ns;
    if (mustCover >= 0) {
      const d = Math.floor(mustCover / M.P), p = mustCover % M.P;
      const opts = [p, p - 1].filter(q => q >= 0 && q + 1 < M.P && M.dblStartP.includes(q + 1)).map(q => d * M.P + q);
      if (!opts.length) return null;
      ns = opts[Math.floor(R() * opts.length)];
    } else {
      const d = Math.floor(R() * M.D), q = M.dblStartP[Math.floor(R() * M.dblStartP.length)] - 1;
      ns = d * M.P + q;
    }
    if (ns === cur) return null;
    const oldS = [cur, cur + 1], newS = [ns, ns + 1];
    const into = newS.filter(s => !oldS.includes(s)), outOf = oldS.filter(s => !newS.includes(s));
    const disp = into.map(s => st.grid[base + s]);
    if (disp.some(o => o < 0 || st.pinned[o])) return null;
    // إذا كان المزاح مزدوجًا آخر: تبادل كامل إن أمكن
    const dbl = disp.filter(o => M.lessons[o].len === 2);
    if (dbl.length) {
      const o = dbl[0];
      if (st.pos[o] !== ns || into.length !== 2 || !validDblStart(M, cur)) return null;
      return [[l, ns], [o, cur]];
    }
    const res = [[l, ns]];
    // المفردات المزاحة تذهب للخانات التي أخلاها المزدوج
    const sortedInto = into.slice().sort((a, b) => a - b), sortedOut = outOf.slice().sort((a, b) => a - b);
    for (let i = 0; i < sortedInto.length; i++) res.push([st.grid[base + sortedInto[i]], sortedOut[i]]);
    return res;
  }

  function applyMoves(st, mv) {
    for (const [l] of mv) unplace(st, l);
    for (const [l, s] of mv) place(st, l, s);
  }
  function tryMove(st, mv) {
    const ls = mv.map(m => m[0]);
    const oldPos = ls.map(l => st.pos[l]);
    const slotsAll = ls.map((l, i) => slotsOf(st, l, oldPos[i]).concat(slotsOf(st, l, mv[i][1])));
    const ctx = ctxFor(st, ls, slotsAll);
    const before = localCost(st, ctx);
    applyMoves(st, mv);
    const after = localCost(st, ctx);
    return { delta: after - before, undo: ls.map((l, i) => [l, oldPos[i]]) };
  }

  // ---------- البدء ----------
  function initialFill(st, R, keep) {
    const { M } = st;
    for (let sec = 0; sec < M.secs.length; sec++) {
      const base = sec * M.S;
      const ls = M.secLessons[sec].filter(l => !(keep && st.pos[l] >= 0 && st.pinned[l]));
      for (const l of ls) unplace(st, l);
      const dbl = ls.filter(l => M.lessons[l].len === 2), sgl = ls.filter(l => M.lessons[l].len === 1);
      for (const l of dbl) {
        let ok = false;
        for (let tries = 0; tries < 200 && !ok; tries++) {
          const d = Math.floor(R() * M.D), q = M.dblStartP[Math.floor(R() * M.dblStartP.length)] - 1, s = d * M.P + q;
          if (st.grid[base + s] < 0 && st.grid[base + s + 1] < 0) { place(st, l, s); ok = true; }
        }
        if (!ok) for (let s = 0; s < M.S - 1 && !ok; s++) if (validDblStart(M, s) && st.grid[base + s] < 0 && st.grid[base + s + 1] < 0) { place(st, l, s); ok = true; }
        if (!ok) return false;
      }
      const free = []; for (let s = 0; s < M.S; s++) if (st.grid[base + s] < 0) free.push(s);
      for (let i = free.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [free[i], free[j]] = [free[j], free[i]]; }
      if (free.length !== sgl.length) return false;
      sgl.forEach((l, i) => place(st, l, free[i]));
    }
    return true;
  }
  function initMeetings(st, R) {
    const { M } = st;
    for (let j = 0; j < M.subj.length; j++) if (M.meetVar[j]) st.meet[j] = [Math.floor(R() * M.S)];
    rebuildBlocked(st);
  }

  // الدروس المشتركة في مخالفات إلزامية
  function hotLessons(st) {
    const { M } = st, hot = new Set();
    for (let sec = 0; sec < M.secs.length; sec++) for (let s = 0; s < M.S; s++) {
      const l = st.grid[sec * M.S + s]; if (l < 0) continue; const L = M.lessons[l];
      let bad = false;
      for (const t of L.teachers) if (tTerm(st, t, s) > 0) bad = true;
      if (capTerm(st, L.fac, s) > 0) bad = true;
      const p = s % M.P + 1;
      if (st.rc.sameBreak && M.breaks.has(p) && p < M.P) { const n = st.grid[sec * M.S + s + 1]; if (n >= 0 && n !== l && M.lessons[n].subj === L.subj) bad = true; }
      if (st.rc.sameBreak && M.breaks.has(p - 1) && p > 1) { const n = st.grid[sec * M.S + s - 1]; if (n >= 0 && n !== l && M.lessons[n].subj === L.subj) bad = true; }
      if (!bad && st.tMode[L.subj] === 1 && st.tLast[s % M.P]) bad = true;
      if (!bad && st.rules[L.subj].length) {
        const d = Math.floor(s / M.P), c = secDayCounts(st, sec, d)[L.subj] || 0;
        for (const r of st.rules[L.subj]) if (r.secs.has(sec) && (c > r.max || (r.maxDaysOver != null && c > 1 && ruleWeekHard(st, sec) > 0))) bad = true;
      }
      if (bad) hot.add(l);
    }
    // حدود الحصص الأولى والأخيرة: دروس المعلم في هذه الخانات (فوق الحد) أو خارجها (تحت الحد)
    if (st.rc.fl) {
      const fS = new Set(M.firstSlots), lS = new Set(M.lastSlots);
      for (let t = 0; t < M.T.length; t++) {
        const lim = st.rc.fl[t]; if (!lim || !flTerm(st, t)) continue;
        const c = flCount(st, t);
        const oF = lim.maxF != null && c.F > lim.maxF, uF = lim.minF != null && c.F < lim.minF, oL = lim.maxL != null && c.L > lim.maxL, uL = lim.minL != null && c.L < lim.minL;
        for (const l of M.tLessons[t]) {
          const s0 = st.pos[l]; if (s0 < 0) continue; let inF = false, inL = false;
          for (let k = 0; k < M.lessons[l].len; k++) { if (fS.has(s0 + k)) inF = true; if (lS.has(s0 + k)) inL = true; }
          if ((oF && inF) || (oL && inL) || (uF && !inF) || (uL && !inL)) hot.add(l);
        }
      }
    }
    return [...hot];
  }

  // نقل اجتماع القسم المتغير
  function tryMeetMove(st, R, j) {
    const { M } = st, old = st.meet[j][0], ns = Math.floor(R() * M.S);
    if (ns === old) return null;
    const keys = new Set(); for (const t of M.deptTeachers[j]) { keys.add((t << 8) | old); keys.add((t << 8) | ns); }
    const ctx = { tk: keys, ck: [], dk: [], ls: [] };
    const before = localCost(st, ctx);
    st.meet[j] = [ns]; rebuildBlocked(st);
    const after = localCost(st, ctx);
    return { delta: after - before, undo: () => { st.meet[j] = [old]; rebuildBlocked(st); } };
  }

  // ---------- البحث (تلدين محاكى) ----------
  // يعمل على دفعات حتى لا تتجمد الواجهة؛ يستدعي onProgress
  function solve(school, opts = {}) {
    const M = buildModel(school);
    if (M.problems.length) return { ok: false, model: M, problems: M.problems };
    const seed = opts.seed || 12345;
    const R = rng(seed);
    const st = createState(M);
    setRules(st, opts.rules || []); setTiming(st, opts.timing); if (opts.rc) setRuleConfig(st, opts.rc); (opts.exempt || []).forEach(t => { if (t >= 0 && t < st.exempt.length) st.exempt[t] = 1; });
    if (opts.fromState) {
      loadInto(st, opts.fromState);
      if (opts.anchor) { st.anchor = Int32Array.from(opts.anchor); st.anchorW = opts.anchorW || 0.3; }
    } else {
      (opts.unavail || []).forEach(([t, ss]) => ss.forEach(s => st.unavail[t] && st.unavail[t].add(s)));
      initMeetings(st, R);
      if (!initialFill(st, R)) return { ok: false, model: M, problems: ['تعذّر الملء الأولي للشبكة'] };
    }
    const iters = opts.iterations || 3000000;
    const T0 = opts.T0 || 3, T1 = opts.T1 || 0.02;
    let cost = fullCost(st).total;
    let best = cost, bestSnap = snapshot(st);
    let hot = hotLessons(st), hotAge = 0;
    const varDepts = opts.fixMeet ? [] : M.subj.map((s, j) => j).filter(j => M.meetVar[j]);
    const nL = M.lessons.length;
    let i = 0;
    const step = (budget) => {
      const end = Math.min(iters, i + budget);
      for (; i < end; i++) {
        const temp = T0 * Math.pow(T1 / T0, i / iters);
        if (varDepts.length && R() < 0.002) {
          const r = tryMeetMove(st, R, varDepts[Math.floor(R() * varDepts.length)]);
          if (r) { if (r.delta <= 0 || R() < Math.exp(-r.delta / temp)) cost += r.delta; else r.undo(); }
          continue;
        }
        let l;
        if (hot.length && R() < 0.6) l = hot[Math.floor(R() * hot.length)];
        else l = Math.floor(R() * nL);
        const mv = proposeMove(st, R, l); if (!mv) continue;
        const r = tryMove(st, mv);
        if (r.delta <= 0 || R() < Math.exp(-r.delta / temp)) {
          cost += r.delta;
          if (cost < best - 1e-9) { best = cost; bestSnap = snapshot(st); }
        } else applyMoves(st, r.undo);
        if (++hotAge > 4000) { hot = hotLessons(st); hotAge = 0; if (!hot.length && best < 1e-9) break; }
      }
      return i >= iters;
    };
    return { ok: true, model: M, state: st, step, progress: () => ({ i, iters, cost, best }), best: () => { loadInto(st, bestSnap); st.anchor = null; st.anchorW = 0; return st; } };
  }

  function snapshot(st) { return { pos: Array.from(st.pos), meet: st.meet.map(a => a.slice()), unavail: unavailList(st) }; }
  function loadInto(st, snap) {
    const { M } = st;
    st.grid.fill(-1); st.occ.fill(0); st.capc.fill(0); st.pos.fill(-1);
    st.meet = snap.meet.map(a => a.slice());
    st.unavail.forEach(s => s.clear()); (snap.unavail || []).forEach(([t, ss]) => { if (st.unavail[t]) ss.forEach(s => st.unavail[t].add(s)); });
    rebuildBlocked(st);
    snap.pos.forEach((s, l) => { if (s >= 0) place(st, l, s); });
    if (snap.pinned) snap.pinned.forEach((v, l) => st.pinned[l] = v ? 1 : 0);
  }

  // ---------- الفحص الكامل (مستقل عن دالة التكلفة) ----------
  function validate(st) {
    const { M } = st, issues = [];
    const sname = (s) => `${M.school.days[Math.floor(s / M.P)]} الحصة ${s % M.P + 1}`;
    const tOcc = M.T.map(() => new Map());
    // اكتمال الأنصبة وموضع كل درس
    for (let l = 0; l < M.lessons.length; l++) {
      const L = M.lessons[l], s = st.pos[l];
      if (s < 0) { issues.push({ type: 'نصاب', msg: `درس ${M.subj[L.subj].name} للشعبة ${M.secs[L.sec]} غير موزع` }); continue; }
      if (L.len === 2) {
        const p = s % M.P + 1;
        if (p + 1 > M.P || !M.dblStartP.includes(p)) issues.push({ type: 'مزدوج', msg: `${M.subj[L.subj].name} للشعبة ${M.secs[L.sec]} في ${sname(s)}: الحصتان غير صالحتين (${p + 1 > M.P ? 'تتجاوزان آخر اليوم' : 'تعبران فرصة'})` });
      }
      for (let k = 0; k < L.len; k++) for (const t of L.teachers) {
        const m = tOcc[t]; if (!m.has(s + k)) m.set(s + k, []); m.get(s + k).push(l);
      }
    }
    // حصص بلا معلم
    const noT = new Set();
    M.lessons.forEach(L => { if (!L.teachers.length) noT.add(L.sec * 100 + L.subj); });
    noT.forEach(k => issues.push({ type: 'إسناد', msg: `الشعبة ${M.secs[Math.floor(k / 100)]}: مادة ${M.subj[k % 100].name} بلا معلم مسند` }));
    // تعارض الشعبة: كل خانة درس واحد بالضبط
    for (let sec = 0; sec < M.secs.length; sec++) {
      const seen = new Array(M.S).fill(0);
      for (const l of M.secLessons[sec]) { const L = M.lessons[l]; if (st.pos[l] >= 0) for (let k = 0; k < L.len; k++) seen[st.pos[l] + k]++; }
      for (let s = 0; s < M.S; s++) {
        if (seen[s] > 1) issues.push({ type: 'شعبة', msg: `الشعبة ${M.secs[sec]} لها ${seen[s]} مواد في ${sname(s)}` });
        if (seen[s] === 0 && !M.explicit) issues.push({ type: 'شعبة', msg: `الشعبة ${M.secs[sec]} بلا حصة في ${sname(s)}` });
      }
      // عبور الفرصة
      if (st.rc.sameBreak) for (let d = 0; d < M.D; d++) for (const b of M.breaks) {
        if (b >= M.P) continue;
        const a = st.grid[sec * M.S + d * M.P + b - 1], c = st.grid[sec * M.S + d * M.P + b];
        if (a >= 0 && c >= 0 && a !== c && M.lessons[a].subj === M.lessons[c].subj)
          issues.push({ type: 'فرصة', msg: `الشعبة ${M.secs[sec]}: ${M.subj[M.lessons[a].subj].name} في الحصتين ${b} و${b + 1} يوم ${M.school.days[d]} (تعبر الفرصة)` });
      }
    }
    // قوانين الجدول (الحد اليومي وعدد الأيام بحصتين)
    const nPer = (n) => n === 1 ? 'حصة واحدة' : n === 2 ? 'حصتان' : `${n} حصص`;
    const nMax = (n) => n === 1 ? 'حصة واحدة' : n === 2 ? 'حصتان' : `${n} حصص`;
    for (let sec = 0; sec < M.secs.length; sec++) {
      const cs = Array.from({ length: M.D }, (_, d) => secDayCounts(st, sec, d));
      for (let j = 0; j < M.subj.length; j++) for (const r of st.rules[j]) {
        if (!r.secs.has(sec)) continue;
        cs.forEach((c, d) => { if ((c[j] || 0) > r.max) issues.push({ type: 'قانون', msg: `للشعبة ${M.secs[sec]} ${nPer(c[j])} من ${M.subj[j].name} يوم ${M.school.days[d]}، والحد المسموح ${nMax(r.max)}` }); });
        if (r.maxDaysOver != null) { const days = cs.map((c, d) => (c[j] || 0) > 1 ? M.school.days[d] : null).filter(Boolean); if (days.length > r.maxDaysOver) issues.push({ type: 'قانون', msg: `للشعبة ${M.secs[sec]} أكثر من حصة ${M.subj[j].name} في ${days.length} أيام (${days.join('، ')})، والمسموح يوم واحد فقط` }); }
      }
    }
    // منع الحصص الأخيرة لمواد محددة
    const lastTxt = () => { const a = []; st.tLast.forEach((v, i) => v && a.push(i + 1)); return a.length === 1 ? `الحصة ${a[0]}` : 'الحصص ' + a.join(' و'); };
    for (let l = 0; l < M.lessons.length; l++) {
      const L = M.lessons[l]; if (st.tMode[L.subj] !== 1 || st.pos[l] < 0) continue;
      for (let k = 0; k < L.len; k++) { const s = st.pos[l] + k; if (st.tLast[s % M.P]) issues.push({ type: 'توقيت', l, msg: `${M.subj[L.subj].name} للشعبة ${M.secs[L.sec]} في ${sname(s)}: المادة ممنوعة من ${lastTxt()}` }); }
    }
    // تعارض المعلم والاجتماع
    for (let t = 0; t < M.T.length; t++) {
      for (const [s, ls] of tOcc[t]) {
        if (ls.length > 1) issues.push({ type: 'معلم', msg: `${M.T[t].name}: ${ls.length} شعب في ${sname(s)} (${ls.map(l => M.secs[M.lessons[l].sec]).join('، ')})` });
      }
      const j = M.T[t].subj;
      if (st.rc.deptBlock && j != null) for (const s of st.meet[j]) if (tOcc[t].has(s)) issues.push({ type: 'اجتماع', msg: `${M.T[t].name}: حصة في اجتماع قسم ${M.subj[j].name} (${sname(s)})` });
      for (const s of st.unavail[t]) if (tOcc[t].has(s)) issues.push({ type: 'توفر', msg: `${M.T[t].name}: غير متاح في ${sname(s)} (قيد دائم) وله حصة فيه` });
      if (st.exempt[t]) for (const s of M.lastSlots) if (tOcc[t].has(s) && !st.unavail[t].has(s)) issues.push({ type: 'إعفاء', t, msg: `${M.T[t].name}: المعلم معفى من الحصة الأخيرة، وله حصة في ${sname(s)} (${tOcc[t].get(s).map(l => M.secs[M.lessons[l].sec]).join('، ')})` });
    }
    // كل قسم له اجتماع (عدا المستثنى، وعند تفعيل اشتراط الاجتماع الأسبوعي)
    if (st.rc.deptReq) for (let j = 0; j < M.subj.length; j++) if (!st.meet[j].length && !(M.school.noMeeting || []).includes(M.subj[j].name)) issues.push({ type: 'اجتماع', msg: `قسم ${M.subj[j].name} بلا موعد اجتماع` });
    // اجتماع الإدارة: لا تدريس للمشاركين (رؤساء الأقسام ومن أُضيف) في مواعيده
    for (const t of st.rc.adminT) for (const s of st.rc.adminSlots) if (tOcc[t] && tOcc[t].has(s)) issues.push({ type: 'اجتماع الإدارة', t, msg: `${M.T[t].name}: حصة في موعد اجتماع الإدارة (${sname(s)}) — ${tOcc[t].get(s).map(l => M.secs[M.lessons[l].sec]).join('، ')}` });
    // سعة المرافق: على مستوى المدرسة في كل يوم وحصة (المزدوجة تشغل الحصتين)، والمواد المشتركة في المرفق نفسه تُحسب معًا
    for (let f = 0; f < M.facs.length; f++) {
      const F = M.facs[f], c = F.cap; if (!c) continue;
      for (let s = 0; s < M.S; s++) {
        const by = {}; let n = 0;
        let grp = false;
        for (let sec = 0; sec < M.secs.length; sec++) { const l = st.grid[sec * M.S + s]; if (l >= 0 && M.lessons[l].fac === f) { const L = M.lessons[l]; n += L.fw; if (L.fw > 1) grp = true; const nm = M.subj[L.subj].name + (L.fw > 1 ? ' — مجموعات' : ''); by[nm] = (by[nm] || 0) + L.fw; } }
        if (n > c) issues.push({ type: 'مرفق', msg: `${F.msg || F.name + ' ممتلئ'}: ${n} ${grp ? 'ورش/مجموعات' : 'شعب'} في ${sname(s)} (${Object.entries(by).map(([k, v]) => `${k} ${v}`).join('، ')})، والسعة ${c}` });
      }
    }
    // الدراسات العملية: تخصص كل معلم مجموعة يطابق منهج صف الشعبة في الفصل الدراسي؛ معلم بلا تخصص = بيانات ناقصة
    if (M.school.prac) {
      const P0 = M.school.prac, SPN = { elec: 'كهرباء', deco: 'ديكور' }, seen = new Set(), miss = {};
      M.lessons.forEach((L, l) => {
        if (L.spec === undefined || M.subj[L.subj].name !== P0.subj) return;
        const sec = M.secs[L.sec];
        if (!L.spec) { if (!seen.has('g' + sec)) { seen.add('g' + sec); issues.push({ type: 'تخصص', msg: `الشعبة ${sec}: لم يُحدد منهج الدراسات العملية لصفها في الفصل الدراسي ${P0.sem === 2 ? 'الثاني' : 'الأول'}` }); } return; }
        L.teachers.forEach(t => {
          const sp = (P0.spec || {})[String(M.T[t].id)], k = t + '|' + sec; if (seen.has(k)) return; seen.add(k);
          if (!sp) { (miss[t] = miss[t] || []).push(sec); return; }
          if (sp !== L.spec) issues.push({ type: 'تخصص', t, msg: `${M.T[t].name}: تخصصه ${SPN[sp]}، ومسند للشعبة ${sec} ومنهجها في الفصل ${P0.sem === 2 ? 'الثاني' : 'الأول'} ${SPN[L.spec]}` });
        });
      });
      for (const t in miss) issues.push({ type: 'تخصص', t: +t, msg: `${M.T[t].name}: بيانات ناقصة — لم يُحدد تخصصه (كهرباء أو ديكور)، ومسند ${miss[t].length > 1 ? 'لـ' + miss[t].length + ' شعب' : 'للشعبة'} ${miss[t].join('، ')}` });
    }
    // حدود الحصص الأولى والأخيرة لكل معلم
    if (st.rc.fl) {
      const K = { minF: ['الحصص الأولى', 'F', 'الحد الأدنى', -1], maxF: ['الحصص الأولى', 'F', 'الحد الأقصى', 1], minL: ['الحصص الأخيرة', 'L', 'الحد الأدنى', -1], maxL: ['الحصص الأخيرة', 'L', 'الحد الأقصى', 1] };
      for (let t = 0; t < M.T.length; t++) {
        const lim = st.rc.fl[t]; if (!lim) continue; const c = flCount(st, t);
        for (const k in K) { const v = lim[k]; if (v == null) continue; const n = k.endsWith('F') ? c.F : c.L, [nm, code, kind, dir] = K[k];
          if ((dir > 0 && n > v) || (dir < 0 && n < v)) issues.push({ type: 'أولى وأخيرة', t, key: k, msg: `${M.T[t].name}: ${nm} (${code}) ${n} أسبوعيًا، و${kind} ${v}` }); }
      }
    }
    // عدد المناهج لكل معلم (إسناد الشعب لا يتغير تلقائيًا؛ للمراجعة فقط)
    if (st.rc.curr) for (let t = 0; t < M.T.length; t++) {
      const lim = st.rc.curr[t]; if (lim == null) continue;
      const cs = teacherCurricula(M, t); if (cs.length <= lim) continue;
      issues.push({ type: 'مناهج', t, msg: `${M.T[t].name}: ${cs.length} مناهج (${cs.map(x => `${x.subj} للصف ${x.grade}: ${x.secs.join('، ')}`).join('؛ ')})، والحد الأقصى ${lim}` });
    }
    // الجدول المستورد: مادة يلزمها التتابع ولها حصص مفردة
    if (M.explicit) {
      const seen = new Set();
      M.lessons.forEach(L => { if (L.len === 1 && M.subj[L.subj].double) { const k = L.sec + '|' + L.subj; if (!seen.has(k)) { seen.add(k); issues.push({ type: 'مزدوج', msg: `${M.subj[L.subj].name} للشعبة ${M.secs[L.sec]}: الإعداد يلزم حصتين متتاليتين، والجدول المستورد فيه حصص مفردة لها` }); } } });
    }
    return issues;
  }

  // فحص تعديل يدوي قبل تطبيقه: يرجع قائمة المخالفات التي يُحدثها أو تبقى بعده
  function checkMove(st, mv) {
    const before = validate(st).map(x => x.msg);
    applyMoves(st, mv);
    const after = validate(st);
    // التراجع يتم من المستدعي
    const added = after.filter(x => !before.includes(x.msg));
    return { added, after };
  }

  // تعديل يدوي حتمي: تبديل خانة A مع خانة B في الشعبة نفسها
  function manualMove(st, sec, sA, sB) {
    const { M } = st, base = sec * M.S;
    const a = st.grid[base + sA], b = st.grid[base + sB];
    if (a < 0 || b < 0) return { err: 'خانة فارغة' };
    if (a === b) return { err: 'اختر حصة أخرى غير الحصة نفسها' };
    const A = M.lessons[a], B = M.lessons[b];
    const covers = (s) => { const d = Math.floor(s / M.P), p = s % M.P; return [p, p - 1].filter(q => q >= 0 && q + 1 < M.P && M.dblStartP.includes(q + 1)).map(q => d * M.P + q); };
    if (A.len === 1 && B.len === 1) return { mv: [[a, sB], [b, sA]] };
    const dl = A.len === 2 ? a : b, target = A.len === 2 ? sB : sA;
    if (A.len === 2 && B.len === 2) {
      const pa = st.pos[a], pb = st.pos[b];
      return { mv: [[a, pb], [b, pa]] };
    }
    const opts = covers(target);
    if (!opts.length) return { err: 'لا يمكن وضع الحصة المزدوجة هنا: الحصتان المتتاليتان تعبران فرصة أو تتجاوزان آخر اليوم' };
    const cur = st.pos[dl];
    const ns = opts.includes(target) ? target : opts[0];
    if (ns === cur) return { err: 'الحصة المزدوجة في هذا الموضع بالفعل' };
    const oldS = [cur, cur + 1], newS = [ns, ns + 1];
    const into = newS.filter(s => !oldS.includes(s)).sort((x, y) => x - y), outOf = oldS.filter(s => !newS.includes(s)).sort((x, y) => x - y);
    const disp = into.map(s => st.grid[base + s]);
    if (disp.some(o => M.lessons[o].len === 2)) return { err: 'الموضع الجديد يتداخل مع حصة مزدوجة أخرى؛ بدّل الحصتين المزدوجتين مباشرة' };
    const mv = [[dl, ns]]; into.forEach((s, i) => mv.push([disp[i], outOf[i]]));
    return { mv };
  }

  function hardTotal(st) {
    const { M } = st; let h = 0;
    for (let i = 0; i < st.occ.length; i++) { const o = st.occ[i]; if (o) h += (o > 1 ? o - 1 : 0) + (st.blocked[i] ? o : 0); }
    for (let f = 0; f < M.facs.length; f++) { const c = M.facs[f].cap; if (!c) continue; for (let s = 0; s < M.S; s++) { const v = st.capc[f * M.S + s]; if (v > c) h += v - c; } }
    if (st.rc.fl) for (let t = 0; t < M.T.length; t++) h += flTerm(st, t);
    for (let sec = 0; sec < M.secs.length; sec++) for (let d = 0; d < M.D; d++) {
      const base = sec * M.S + d * M.P;
      if (st.rc.sameBreak) for (const b of M.breaks) { if (b >= M.P) continue; const a = st.grid[base + b - 1], c = st.grid[base + b]; if (a >= 0 && c >= 0 && a !== c && M.lessons[a].subj === M.lessons[c].subj) h++; }
      h += ruleDayHard(st, sec, d);
    }
    for (let sec = 0; sec < M.secs.length; sec++) h += ruleWeekHard(st, sec);
    for (let l = 0; l < M.lessons.length; l++) h += lateHard(st, l);
    return h;
  }
  // late: حصص مواد «التقليل» في الحصص الأخيرة؛ lateBy: لكل مادة (كل المواد) عدد حصصها في الحصص الأخيرة
  function softSummary(st) {
    const { M } = st; let late = 0, dup = 0; const lateBy = M.subj.map(() => 0);
    M.lessons.forEach((L, l) => { const n = lastCount(st, l); if (!n) return; lateBy[L.subj] += n; if (st.tMode[L.subj] === 2) late += n; });
    for (let sec = 0; sec < M.secs.length; sec++) for (let d = 0; d < M.D; d++) {
      const c = {}; for (let p = 0; p < M.P; p++) { const l = st.grid[sec * M.S + d * M.P + p]; if (l < 0 || M.lessons[l].len === 2) continue; c[M.lessons[l].subj] = (c[M.lessons[l].subj] || 0) + 1; }
      for (const k in c) if (c[k] > 1) dup += c[k] - 1;
    }
    return { late, lateBy, dup };
  }
  // نقل الدرس l إلى الوقت s داخل شعبته (تبديل مع الموجود هناك)
  function moveLessonTo(st, l, s) {
    const L = st.M.lessons[l], cur = st.pos[l];
    if (cur === s || (L.len === 2 && cur + 1 === s && !validDblStart(st.M, s))) return { mv: [] };
    return manualMove(st, L.sec, cur, s);
  }
  /* البحث عن حلول لطلب تعديل، بأقل عدد من الحصص المتحركة.
     req.initial: قائمة خطوات [[lesson, start], ...] تُطبّق أولًا (الطلب نفسه)
     req.pins: دروس لا يحركها البحث بعد ذلك
     req.forbid: [[teacher, slot], ...] أوقات يجب أن يخلو فيها المعلم (قيد للطلب)
     ترجع الحلول مرتبة: الأقل تغييرًا أولًا. لا تغيّر st عند الانتهاء. */
  function searchSolutions(st, req) {
    const { M } = st;
    const t0 = Date.now(), budget = req.budgetMs || 2000, maxDepth = req.maxDepth == null ? 4 : req.maxDepth, beam = req.beam || 10, maxSol = req.maxSol || 6;
    const base = snapshot(st);
    // baseMsgs/H0: مخالفات الأساس من حالة سابقة (مثل الجدول قبل نقل اجتماع)، فلا تُقبل المخالفات الجديدة الناتجة عن الطلب
    const baseIssues = req.baseMsgs ? new Set(req.baseMsgs) : req.repair ? new Set() : new Set(validate(st).map(x => x.msg));
    const H0 = req.H0 != null ? req.H0 : req.repair ? 0 : hardTotal(st);
    const finish = (out) => { st.temp.forEach(s => s.clear()); st.pinned.fill(0); loadInto(st, base); return out; };
    (req.forbid || []).forEach(([t, s]) => st.temp[t].add(s)); rebuildBlocked(st);
    const pins = new Set(req.pins || []);
    const applyPath = (path) => { st.pinned.fill(0); loadInto(st, base); for (const mv of path) applyMoves(st, mv); pins.forEach(l => st.pinned[l] = 1); };
    const changesOf = () => { const ch = []; for (let l = 0; l < M.lessons.length; l++) if (st.pos[l] !== base.pos[l]) ch.push({ l, from: base.pos[l], to: st.pos[l] }); return ch; };
    const forbidOk = () => (req.forbid || []).every(([t, s]) => st.occ[t * M.S + s] === 0);
    const addedIssues = () => validate(st).filter(x => !baseIssues.has(x.msg));
    // الخطوة الأولى: الطلب نفسه
    const init = (req.initial || []).filter(mv => mv && mv.length);
    applyPath(init);
    const firstIssues = addedIssues();
    const forbidMsgs = () => (req.forbid || []).filter(([t, s]) => st.occ[t * M.S + s] > 0).map(([t, s]) => `${M.T[t].name}: له حصة في ${M.school.days[Math.floor(s / M.P)]} الحصة ${s % M.P + 1} المطلوب إخلاؤها`);
    const firstReasons = firstIssues.map(x => x.msg).concat(forbidMsgs());
    const sols = [], seen = new Set();
    const record = (path) => {
      const ch = changesOf(); const key = ch.map(c => c.l + ':' + c.to).sort().join(',');
      if (seen.has(key)) return; seen.add(key);
      if (!forbidOk() || addedIssues().length) return;
      const soft = softSummary(st);
      sols.push({ path: path.map(mv => mv.map(x => x.slice())), changes: ch, swaps: path.length, soft });
    };
    if (hardTotal(st) <= H0 && forbidOk() && !firstIssues.length) record(init);
    let frontier = [{ path: init, h: hardTotal(st) }];
    for (let depth = 0; depth < maxDepth && sols.length < maxSol && Date.now() - t0 < budget; depth++) {
      const children = [];
      for (const node of frontier) {
        if (Date.now() - t0 > budget) break;
        applyPath(node.path);
        if (node.h <= H0 && !forbidOk()) { /* ok */ }
        let culprits = hotLessons(st).filter(l => !st.pinned[l]);
        // معلم مطلوب إخلاؤه: دروسه في الوقت الممنوع
        (req.forbid || []).forEach(([t, s]) => { M.lessons.forEach((L, l) => { if (L.teachers.includes(t) && st.pos[l] >= 0 && s >= st.pos[l] && s < st.pos[l] + L.len && !st.pinned[l] && !culprits.includes(l)) culprits.push(l); }); });
        if (culprits.length > 8) culprits = culprits.slice(0, 8);
        for (const c of culprits) {
          const L = M.lessons[c];
          for (let s = 0; s < M.S; s++) {
            if (s === st.pos[c]) continue;
            const r = manualMove(st, L.sec, st.pos[c], s);
            if (r.err || !r.mv.length || r.mv.some(([x]) => st.pinned[x])) continue;
            const undo = r.mv.map(([x]) => [x, st.pos[x]]);
            applyMoves(st, r.mv);
            const h = hardTotal(st);
            let nch = 0; for (let l = 0; l < M.lessons.length; l++) if (st.pos[l] !== base.pos[l]) nch++;
            children.push({ path: node.path.concat([r.mv]), h, nch });
            applyMoves(st, undo);
          }
        }
      }
      children.sort((a, b) => a.h - b.h || a.nch - b.nch);
      const next = [];
      for (const ch of children) {
        if (ch.h <= H0) { applyPath(ch.path); record(ch.path); if (sols.length >= maxSol) break; continue; }
        if (next.length < beam) next.push(ch);
      }
      frontier = next;
      if (!frontier.length) break;
    }
    sols.sort((a, b) => a.changes.length - b.changes.length || a.swaps - b.swaps || (a.soft.late + a.soft.dup * 0.5) - (b.soft.late + b.soft.dup * 0.5));
    return finish({ solutions: sols, firstReasons, timedOut: Date.now() - t0 >= budget });
  }


  // ================= إعدادات وقوانين الجدول (لكل مدرسة) =================
  // المرافق الافتراضية للمواد ذات السعة (تُستخدم فقط إن لم تُحدد سعة المادة في إعدادات الجدول)
  const FAC_DEFAULT = { 'التربية الفنية': [2, 'المرسم'], 'التربية البدنية': [2, 'الملعب والصالة'], 'التربية الموسيقية': [1, 'غرفة الموسيقى'] };
  // الدراسات العملية: ورش لكل تخصص (تصحيح الإعداد السابق «ورشتان إجمالًا»): ورشتان كهرباء + ورشتان ديكور
  const PRAC_SUBJ = 'الدراسات العملية', SPECS = ['elec', 'deco'], SPEC_AR = { elec: 'كهرباء', deco: 'ديكور' };
  const PRAC_WS = [{ id: 'ws-elec', name: 'ورش الكهرباء', cap: 2, spec: 'elec' }, { id: 'ws-deco', name: 'ورش الديكور', cap: 2, spec: 'deco' }];
  // المنهج الافتراضي لكل صف وفصل دراسي
  const PRAC_CURR = { 1: { 6: 'deco', 7: 'elec', 8: 'deco', 9: 'elec' }, 2: { 6: 'elec', 7: 'deco', 8: 'elec', 9: 'deco' } };
  function defaultPrac() { return { v: 1, subj: PRAC_SUBJ, sem: 1, spec: {}, curr: { 1: Object.assign({}, PRAC_CURR[1]), 2: Object.assign({}, PRAC_CURR[2]) }, split: 'same', assign: { 1: {}, 2: {} } }; }
  /* إعدادات الدراسات العملية لكل مدرسة: الفصل الدراسي المعروض، تخصص كل معلم (بمعرّفه، دون استنتاج)، منهج كل صف لكل فصل،
     آلية تقسيم الشعبة ('same' مجموعتان من تخصص الفصل نفسه، 'none' دون تقسيم)، وإسناد مجموعات كل شعبة لكل فصل بصورة مستقلة */
  function normPrac(x, school) {
    const D = defaultPrac(); x = isObj(x) ? x : {};
    const grades = [...new Set((school && school.sections || []).map(gradeOfSec))];
    const out = { v: 1, subj: typeof x.subj === 'string' && x.subj ? x.subj : D.subj, sem: x.sem === 2 ? 2 : 1, spec: {}, curr: { 1: {}, 2: {} }, split: x.split === 'none' ? 'none' : 'same', assign: { 1: {}, 2: {} } };
    if (isObj(x.spec)) for (const id in x.spec) if (SPECS.includes(x.spec[id])) out.spec[String(id)] = x.spec[id];
    for (const sm of [1, 2]) {
      const c = isObj(x.curr) && isObj(x.curr[sm]) ? x.curr[sm] : {};
      const gs = new Set(Object.keys(D.curr[sm]).concat(grades));
      gs.forEach(g => { out.curr[sm][g] = SPECS.includes(c[g]) ? c[g] : (D.curr[sm][g] || null); });
      const a = isObj(x.assign) && isObj(x.assign[sm]) ? x.assign[sm] : {};
      for (const sec in a) { const ids = idList(a[sec]).slice(0, 6); if (ids.length) out.assign[sm][String(sec)] = ids; }
    }
    return out;
  }
  // الكائن الذي يقرؤه المحرك للفصل المعروض
  function pracModel(pr) { return { subj: pr.subj, sem: pr.sem, spec: pr.spec, curr: pr.curr[pr.sem], split: pr.split === 'same', assign: pr.assign[pr.sem] }; }
  const FL_KEYS = ['minF', 'maxF', 'minL', 'maxL'];
  const intIn = (v, a, b) => { const n = Number(v); return Number.isInteger(n) && n >= a && n <= b ? n : null; };
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const idList = (a) => (Array.isArray(a) ? [...new Set(a.filter(v => typeof v === 'string' || typeof v === 'number').map(String))] : []);
  // القيم الافتراضية للإعدادات الجديدة. school: كائن المدرسة (المواد والفرص والسعات)، opts.hasRule(subj): قانون قائم للمادة
  function defaultRc(school, opts) {
    const names = (school.subjects || []).map(s => s.name);
    const daily = {};
    if (names.includes('التربية الإسلامية') && !(opts && opts.hasRule && opts.hasRule('التربية الإسلامية'))) daily['التربية الإسلامية'] = { on: true, v: 1 };
    return {
      v: 1,
      curr: { on: false, max: 2, dept: {}, t: {} },
      fl: { def: { mode: 'auto', first: {}, last: {} }, minF: { on: false, v: 0 }, maxF: { on: false, v: (school.days || []).length || 5 }, minL: { on: false, v: 0 }, maxL: { on: false, v: 2 }, dept: {}, t: {} },
      heads: { exempt: true, except: [] },
      meet: { deptReq: true, deptBlock: true, admin: { slots: [], blockHeads: true, extra: [] } },
      fac: null, dbl: {}, crossBreak: false, sameBreak: true, breaks: null, daily, display: { fl: true }
    };
  }
  // توحيد الإعدادات المحفوظة مع الافتراضية: ما ضُبط سابقًا يبقى كما هو، والجديد غير المضبوط يأخذ الافتراضي
  function normRc(rc, school, opts) {
    const D = defaultRc(school, opts), x = isObj(rc) ? rc : {};
    const P = school.periods || 7, nD = (school.days || []).length || 5, S = P * nD, names = new Set((school.subjects || []).map(s => s.name));
    const lim = (o, dflt, maxV) => ({ on: isObj(o) ? !!o.on : dflt.on, v: isObj(o) && intIn(o.v, 0, maxV) != null ? intIn(o.v, 0, maxV) : dflt.v });
    const ovr = (o, keys, maxV) => { const out = {}; if (isObj(o)) for (const id in o) { const e = o[id]; if (keys) { if (!isObj(e)) continue; const y = {}; keys.forEach(k => { const n = intIn(e[k], 0, maxV); if (n != null) y[k] = n; }); if (Object.keys(y).length) out[String(id)] = y; } else { const n = intIn(e, 0, maxV); if (n != null) out[String(id)] = n; } } return out; };
    const perDay = (o) => { const out = {}; if (isObj(o)) for (const d in o) { const di = intIn(d, 0, nD - 1); if (di == null || !Array.isArray(o[d])) continue; const a = [...new Set(o[d].map(Number).filter(p => Number.isInteger(p) && p >= 1 && p <= P))].sort((p, q) => p - q); if (a.length) out[di] = a; } return out; };
    const c = isObj(x.curr) ? x.curr : {}, f = isObj(x.fl) ? x.fl : {}, h = isObj(x.heads) ? x.heads : {}, m = isObj(x.meet) ? x.meet : {}, ma = isObj(m.admin) ? m.admin : {};
    const out = {
      v: 1,
      curr: { on: 'on' in c ? !!c.on : D.curr.on, max: intIn(c.max, 1, 20) != null ? intIn(c.max, 1, 20) : D.curr.max, dept: ovr(c.dept, null, 20), t: ovr(c.t, null, 20) },
      fl: { def: isObj(f.def) && f.def.mode === 'custom' ? { mode: 'custom', first: perDay(f.def.first), last: perDay(f.def.last) } : { mode: 'auto', first: {}, last: {} },
        minF: lim(f.minF, D.fl.minF, nD * P), maxF: lim(f.maxF, D.fl.maxF, nD * P), minL: lim(f.minL, D.fl.minL, nD * P), maxL: lim(f.maxL, D.fl.maxL, nD * P), dept: ovr(f.dept, FL_KEYS, nD * P), t: ovr(f.t, FL_KEYS, nD * P) },
      heads: { exempt: 'exempt' in h ? !!h.exempt : D.heads.exempt, except: idList(h.except) },
      meet: { deptReq: 'deptReq' in m ? !!m.deptReq : true, deptBlock: 'deptBlock' in m ? !!m.deptBlock : true,
        admin: { slots: [...new Set((Array.isArray(ma.slots) ? ma.slots : []).map(Number).filter(v => Number.isInteger(v) && v >= 0 && v < S))].sort((p, q) => p - q), blockHeads: 'blockHeads' in ma ? !!ma.blockHeads : true, extra: idList(ma.extra) } },
      fac: Array.isArray(x.fac) ? x.fac.slice(0, 40).map((e, i) => Object.assign({ id: String((e && e.id) || 'f' + (i + 1)).slice(0, 20), name: String((e && e.name) || 'مرفق').replace(/\s+/g, ' ').trim().slice(0, 60) || 'مرفق', cap: intIn(e && e.cap, 1, 99) || 1, on: !(e && e.on === false), subjects: [...new Set(((e && e.subjects) || []).map(String))].filter(n => names.has(n)) }, e && SPECS.includes(e.spec) ? { spec: e.spec } : {})) : null,
      dbl: {}, crossBreak: !!x.crossBreak, sameBreak: 'sameBreak' in x ? !!x.sameBreak : true,
      breaks: Array.isArray(x.breaks) ? [...new Set(x.breaks.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n < P))].sort((p, q) => p - q) : null,
      daily: {}, display: { fl: !(isObj(x.display) && x.display.fl === false) }
    };
    if (isObj(x.dbl)) for (const k in x.dbl) if (names.has(k)) out.dbl[k] = !!x.dbl[k];
    if (isObj(x.daily)) { for (const k in x.daily) if (names.has(k) && isObj(x.daily[k])) out.daily[k] = { on: !!x.daily[k].on, v: intIn(x.daily[k].v, 1, P) || 1 }; }
    else out.daily = D.daily;
    // مادة في أكثر من مرفق: يبقى أول ربط فقط (لا تكرار متعارض)
    if (out.fac) {
      // تصحيح الإعداد السابق: مرفق واحد للدراسات العملية دون تخصص ← ورش الكهرباء وورش الديكور منفصلة
      if (names.has(PRAC_SUBJ) && !out.fac.some(F => F.spec && F.subjects.includes(PRAC_SUBJ))) {
        out.fac.forEach(F => { F.subjects = F.subjects.filter(n => n !== PRAC_SUBJ); });
        out.fac = out.fac.filter(F => F.subjects.length || !F.name.includes('ورش'));
        PRAC_WS.forEach(w => out.fac.push(Object.assign({}, w, { on: true, subjects: [PRAC_SUBJ] })));
      }
      const used = new Set(); out.fac.forEach(F => { const key = (n) => n + '|' + (F.spec || ''); F.subjects = F.subjects.filter(n => !used.has(key(n))); F.subjects.forEach(n => used.add(key(n))); });
    }
    return out;
  }
  // المرافق الفعلية: المحفوظة، أو المشتقة من سعات المواد في الإعدادات (والافتراضية للمواد الأربع إن لم تُضبط سعتها)
  function facilitiesOf(school, rc) {
    if (rc && Array.isArray(rc.fac)) return rc.fac.map(f => Object.assign({ id: f.id, name: f.name, cap: f.cap, on: f.on, subjects: f.subjects.slice() }, f.spec ? { spec: f.spec } : {}));
    const out = [];
    (school.subjects || []).forEach(s => {
      if (s.name === PRAC_SUBJ) { PRAC_WS.forEach(w => out.push(Object.assign({}, w, { on: true, subjects: [s.name] }))); return; }
      const d = FAC_DEFAULT[s.name], cap = s.cap || (d ? d[0] : 0); if (!cap) return;
      out.push({ id: 'f' + (out.length + 1), name: d ? d[1] : (s.facility || 'مرفق ' + s.name), cap, on: true, subjects: [s.name], note: s.facility || '' });
    });
    return out;
  }
  // كائن المدرسة بعد تطبيق الإعدادات التي تغيّر بنية النموذج: الفرص، عبور الفرص، المرافق، تعريف الأولى والأخيرة، إلزام التتابع لكل مادة
  function schoolWithSettings(school, settings, opts) {
    const rc = normRc(settings && settings.rc, school, opts), out = Object.assign({}, school);
    if (rc.breaks) out.breaks = rc.breaks.slice();
    out.doubleCrossBreak = rc.crossBreak;
    out.facilities = facilitiesOf(school, rc).map(f => Object.assign({}, f, { msg: `${f.name} ${f.spec || /ورش/.test(f.name) ? 'ممتلئة' : 'ممتلئ'}` }));
    out.firstLast = rc.fl.def;
    out.subjects = (school.subjects || []).map(s => (s.name in rc.dbl ? Object.assign({}, s, { double: rc.dbl[s.name] }) : s));
    const pr = normPrac(settings && settings.prac, school);
    if ((school.subjects || []).some(s => s.name === pr.subj)) out.prac = pracModel(pr);
    return out;
  }
  /* القيم الفعلية المطبقة على المحرك من الإعدادات، مع مصدر كل قيمة (عام أو استثناء القسم أو استثناء المعلم).
     opts: { manual, catalogRules: [قوانين معتمدة قائمة], hasRule } */
  function effectiveRules(M, settings, opts) {
    opts = opts || {}; settings = settings || {};
    const rc = normRc(settings.rc, M.school, opts), manual = !!opts.manual;
    const nT = M.T.length, tid = (t) => String(M.T[t].id), dname = (t) => M.T[t].dept;
    // حدود الأولى والأخيرة: المعلم ← القسم ← العام، لكل حد مفعّل
    const flLim = [], flSrc = [];
    for (let t = 0; t < nT; t++) {
      const lim = {}, src = {}; let any = false;
      for (const k of FL_KEYS) {
        if (!rc.fl[k].on) { lim[k] = null; src[k] = 'off'; continue; }
        const to = rc.fl.t[tid(t)], dpo = rc.fl.dept[dname(t)];
        if (to && to[k] != null) { lim[k] = to[k]; src[k] = 'teacher'; } else if (dpo && dpo[k] != null) { lim[k] = dpo[k]; src[k] = 'dept'; } else { lim[k] = rc.fl[k].v; src[k] = 'general'; }
        any = true;
      }
      flLim.push(any ? lim : null); flSrc.push(src);
    }
    const currLim = [], currSrc = [];
    for (let t = 0; t < nT; t++) {
      if (!rc.curr.on) { currLim.push(null); currSrc.push('off'); continue; }
      const to = rc.curr.t[tid(t)], dpo = rc.curr.dept[dname(t)];
      if (to != null) { currLim.push(to); currSrc.push('teacher'); } else if (dpo != null) { currLim.push(dpo); currSrc.push('dept'); } else { currLim.push(rc.curr.max); currSrc.push('general'); }
    }
    // الإعفاء من الحصة الأخيرة: المعلمون المحددون + رؤساء الأقسام (عند التفعيل) عدا المستثنين صراحة
    const exIds = new Set(idList(settings.exempt)), exceptH = new Set(rc.heads.except), exSrc = [];
    const exempt = [];
    for (let t = 0; t < nT; t++) {
      const byT = exIds.has(tid(t)), byH = rc.heads.exempt && M.T[t].head && !exceptH.has(tid(t));
      exSrc.push(byT ? 'teacher' : byH ? 'heads' : M.T[t].head && rc.heads.exempt ? 'excepted' : '');
      if (byT || byH) exempt.push(t);
    }
    // اجتماع الإدارة: رؤساء الأقسام (عند التفعيل) والمشاركون الإضافيون
    const extra = new Set(rc.meet.admin.extra), adminT = [];
    for (let t = 0; t < nT; t++) if ((rc.meet.admin.blockHeads && M.T[t].head) || extra.has(tid(t))) adminT.push(t);
    // قوانين المواد: الحد اليومي لكل مادة + القوانين المعتمدة القائمة (المخصصة بالنطاق)
    const rules = (opts.catalogRules || []).slice();
    for (const name in rc.daily) if (rc.daily[name].on && M.subjIdx[name] != null) rules.push({ id: 'daily:' + name, subj: name, grades: [], sections: [], max: rc.daily[name].v, maxDaysOver: null, name: 'الحد اليومي' });
    const info = { rc, flLim, flSrc, currLim, currSrc, exSrc, adminT };
    if (manual) return { manual, rules: [], timing: null, exempt: [], rc: { fl: null, sameBreak: true, deptBlock: rc.meet.deptBlock, deptReq: rc.meet.deptReq, adminSlots: [], adminT: [], curr: null }, info };
    return { manual, rules, timing: settings.timing || null, exempt, rc: { fl: flLim, sameBreak: rc.sameBreak, deptBlock: rc.meet.deptBlock, deptReq: rc.meet.deptReq, adminSlots: rc.meet.admin.slots, adminT: rc.meet.admin.slots.length ? adminT : [], curr: currLim }, info };
  }
  function applyEffective(st, eff) { setRules(st, eff.rules); setTiming(st, eff.timing); setRuleConfig(st, eff.rc); setExempt(st, eff.exempt); }
  // خيارات solve من الإعدادات الفعلية
  const solveOpts = (eff) => ({ rules: eff.rules, timing: eff.timing, exempt: eff.exempt, rc: eff.rc });
  /* فحص الإعدادات قبل الحفظ والتوليد: errors تمنع الحفظ (حد أدنى أكبر من الأقصى)، conflicts تعارض بين إعدادين يجب تصحيحه،
     infeasible حدود لا يمكن تحقيقها بالبيانات الحالية. لا يُتجاوز أي منها بصمت. */
  function rcProblems(M, settings, opts) {
    const eff = effectiveRules(M, settings, Object.assign({}, opts, { manual: false })), rc = eff.info.rc;
    const errors = [], conflicts = [], infeasible = [], notes = [];
    const L = { minF: 'الحد الأدنى للحصص الأولى', maxF: 'الحد الأقصى للحصص الأولى', minL: 'الحد الأدنى للحصص الأخيرة', maxL: 'الحد الأقصى للحصص الأخيرة' };
    const pair = (o, where) => { [['minF', 'maxF'], ['minL', 'maxL']].forEach(([a, b]) => { if (o[a] != null && o[b] != null && o[a] > o[b]) errors.push(`${where}: ${L[a]} (${o[a]}) أكبر من ${L[b]} (${o[b]}).`); }); };
    pair({ minF: rc.fl.minF.on ? rc.fl.minF.v : null, maxF: rc.fl.maxF.on ? rc.fl.maxF.v : null, minL: rc.fl.minL.on ? rc.fl.minL.v : null, maxL: rc.fl.maxL.on ? rc.fl.maxL.v : null }, 'الإعداد العام');
    const seenErr = new Set();
    M.T.forEach((T, t) => { const lim = eff.info.flLim[t]; if (!lim) return; const before = errors.length; pair(lim, T.name); if (errors.length > before) { const k = errors.slice(before).join(''); if (seenErr.has(k)) errors.length = before; else seenErr.add(k); } });
    const nFirst = M.firstSlots.length, nLast = M.lastSlots.length, ex = new Set(eff.exempt);
    M.T.forEach((T, t) => {
      const lim = eff.info.flLim[t]; const load = M.tLessons[t].reduce((a, l) => a + M.lessons[l].len, 0);
      if (ex.has(t) && lim && lim.minL > 0) conflicts.push(`${T.name}: معفى من الحصة الأخيرة (${eff.info.exSrc[t] === 'heads' ? 'إعفاء رؤساء الأقسام' : 'إعفاء محدد'})، والحد الأدنى للحصص الأخيرة ${lim.minL}. صحّح أحد الإعدادين.`);
      if (!lim) return;
      if (lim.minF != null && lim.minF > Math.min(nFirst, load)) infeasible.push(`${T.name}: الحد الأدنى للحصص الأولى ${lim.minF} أكبر مما يمكن (${Math.min(nFirst, load)}: عدد الحصص الأولى في الأسبوع ${nFirst} ونصابه ${load}).`);
      if (lim.minL != null && !ex.has(t) && lim.minL > Math.min(nLast, load)) infeasible.push(`${T.name}: الحد الأدنى للحصص الأخيرة ${lim.minL} أكبر مما يمكن (${Math.min(nLast, load)}: عدد الحصص الأخيرة في الأسبوع ${nLast} ونصابه ${load}).`);
    });
    // كل شعبة يدرّسها معلم في كل حصة أولى وأخيرة (الجدول من الأنصبة): مجموع الحدود القصوى للمعلمين يجب أن يكفي
    if (!M.explicit) [['maxF', nFirst, 'الأولى'], ['maxL', nLast, 'الأخيرة']].forEach(([k, n, nm]) => {
      if (!rc.fl[k].on) return;
      const need = M.secs.length * n; let cap = 0, open = false;
      M.T.forEach((T, t) => { if (k === 'maxL' && ex.has(t)) return; const lim = eff.info.flLim[t]; if (!lim || lim[k] == null) { open = true; return; } cap += lim[k]; });
      if (!open && cap < need) infeasible.push(`مجموع الحدود القصوى للحصص ${nm} لكل المعلمين${k === 'maxL' ? ' غير المعفين' : ''} (${cap}) أقل من عدد الحصص ${nm} في كل الشعب (${need}).`);
    });
    // كل شعبة تحتاج في كل حصة أخيرة معلمًا غير معفى: شعبة كل دروسها لمعلمين معفين (أو لا تكفي دروس غير المعفين لحصصها الأخيرة) لا يمكن جدولتها
    const lastPerSec = M.lastSlots.length;
    M.secs.forEach((sec, si) => {
      const free = M.secLessons[si].filter(l => M.lessons[l].teachers.some(t => !ex.has(t))).reduce((a, l) => a + M.lessons[l].len, 0);
      if (free < lastPerSec) infeasible.push(`الشعبة ${sec}: تحتاج ${lastPerSec} حصص أخيرة أسبوعيًا، ودروس معلميها غير المعفين من الحصة الأخيرة ${free} فقط${free === 0 ? ' (كل معلميها معفون)' : ''}.`);
    });
    if (rc.meet.admin.blockHeads && !rc.meet.admin.slots.length) notes.push('منع التدريس لرؤساء الأقسام أثناء اجتماع الإدارة مفعّل، ولم يُحدَّد موعد لاجتماع الإدارة؛ لا يُطبَّق حتى تحدد الموعد.');
    // الدراسات العملية: تخصصات ناقصة، ومعلمون مناسبون لمنهج كل صف، وسعة ورش كل تخصص (مستقلة)
    const PR = M.school.prac;
    if (PR && M.subjIdx[PR.subj] != null) {
      const pj = M.subjIdx[PR.subj], semTxt = PR.sem === 2 ? 'الثاني' : 'الأول';
      const pts = M.deptTeachers[pj].filter(t => !(PR.spec || {})[String(M.T[t].id)]);
      if (pts.length) notes.push(`الدراسات العملية: ${pts.length} معلم بلا تخصص محدد (بيانات ناقصة): ${pts.slice(0, 8).map(t => M.T[t].name).join('، ')}${pts.length > 8 ? '…' : ''}. حدّد التخصص من «الدراسات العملية».`);
      const bySpec = { elec: 0, deco: 0 }; M.deptTeachers[pj].forEach(t => { const sp = (PR.spec || {})[String(M.T[t].id)]; if (sp) bySpec[sp]++; });
      const need = { elec: 0, deco: 0 }, maxGrp = { elec: 0, deco: 0 };
      M.lessons.forEach(L => { if (L.subj !== pj || !L.spec) return; need[L.spec] += L.len * L.fw; maxGrp[L.spec] = Math.max(maxGrp[L.spec], L.fw); });
      for (const sp of ['elec', 'deco']) {
        if (!need[sp]) continue;
        const F = M.facs.find(f => f.subjects.includes(PR.subj) && f.spec === sp), nm = SPEC_AR[sp];
        if (!F || !F.cap) { infeasible.push(`الدراسات العملية: منهج ${nm} مطلوب في الفصل ${semTxt}، ولا توجد ورش ${nm} مفعّلة.`); continue; }
        if (maxGrp[sp] > F.cap) infeasible.push(`الدراسات العملية: الشعبة المقسّمة تحتاج ${maxGrp[sp]} ورش ${nm} في الحصة نفسها، والمتاح ${F.cap}.`);
        if (need[sp] > F.cap * M.S) infeasible.push(`الدراسات العملية: حصص ${nm} الأسبوعية تحتاج ${need[sp]} ورشة×حصة، وسعة ورش ${nm} ${F.cap * M.S} في الأسبوع.`);
        if (!bySpec[sp]) notes.push(`الدراسات العملية: لا يوجد معلم محدد تخصصه ${nm}، ومنهج ${nm} مطلوب في الفصل ${semTxt}.`);
      }
    }
    return { errors, conflicts, infeasible, notes, eff };
  }
  // تحويل مواضع المسودة عند تغيّر بنية الدروس (تغيير إلزام التتابع لمادة): الخانات المشغولة لكل شعبة ومادة كما هي
  function convertSnap(oldM, snap, newM) {
    const occ = new Map();
    oldM.lessons.forEach((L, l) => { const s = snap.pos[l]; if (s < 0) return; const k = oldM.secs[L.sec] + '|' + oldM.subj[L.subj].name; if (!occ.has(k)) occ.set(k, []); for (let i = 0; i < L.len; i++) occ.get(k).push(s + i); });
    const pos = new Array(newM.lessons.length).fill(-1), bad = [];
    const groups = new Map(); newM.lessons.forEach((L, l) => { const k = newM.secs[L.sec] + '|' + newM.subj[L.subj].name; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); });
    for (const [k, ls] of groups) {
      const slots = (occ.get(k) || []).slice().sort((a, b) => a - b), used = new Set();
      const dbl = ls.filter(l => newM.lessons[l].len === 2), sgl = ls.filter(l => newM.lessons[l].len === 1);
      for (const l of dbl) {
        if (slots.length - used.size < 2) break; // حصص غير موزعة أصلًا تبقى غير موزعة
        const s = slots.find(x => !used.has(x) && !used.has(x + 1) && slots.includes(x + 1) && validDblStart(newM, x));
        if (s == null) { bad.push(k.replace('|', ' — ')); continue; }
        used.add(s); used.add(s + 1); pos[l] = s;
      }
      for (const l of sgl) { const s = slots.find(x => !used.has(x)); if (s == null) continue; used.add(s); pos[l] = s; }
    }
    return { snap: Object.assign({}, snap, { pos }), bad: [...new Set(bad)] };
  }
  const api = { normPrac, defaultPrac, pracModel, pracGroups, PRAC_SUBJ, SPEC_AR, PRAC_CURR, setRuleConfig, flCount, flCounts, teacherCurricula, defaultRc, normRc, facilitiesOf, schoolWithSettings, effectiveRules, applyEffective, solveOpts, rcProblems, convertSnap, FL_KEYS, setExempt, setTiming, getTiming, lastCount, setRules, manualMove, moveLessonTo, searchSolutions, hardTotal, softSummary, setUnavail, unavailList, hotLessons, buildModel, createState, solve, validate, fullCost, snapshot, loadInto, proposeMove, doubleMoveTo, applyMoves, place, unplace, rebuildBlocked, checkMove, validDblStart, rng };
  if (typeof module !== 'undefined') module.exports = api; else root.TTEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* جدول المدرسة داخل الموقع — عمليات الخادم.
 * الأداة نفسها (الشاشات والتوليد والتعديل) تعمل في المتصفح بالمحرك نفسه، وهنا: الحفظ لكل مدرسة،
 * والصلاحيات، والتحقق النهائي بالمحرك قبل التفعيل، وتحويل الجدول المفعّل إلى جداول الأقسام التي يستخدمها محرك الاحتياط.
 * لا تُنقل بيانات تجريبية: الإعدادات والمعلمون والشعب من بيانات المدرسة في الموقع فقط.
 */
(function (root) {
  'use strict';
  const TTE = root.TTEngine || (typeof require !== 'undefined' ? require('./timetable-engine.js') : null);
  const DAY_AR = { sun: 'الأحد', mon: 'الاثنين', tue: 'الثلاثاء', wed: 'الأربعاء', thu: 'الخميس', fri: 'الجمعة', sat: 'السبت' };
  const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const TT_PERMS = ['ttView', 'ttDraft', 'ttGenerate', 'ttApprove', 'ttPrint'];
  const MAX_VERSIONS = 60, MAX_IMPORTS = 10;
  const SEC_RE = /^[1-9][0-9]?-[1-9][0-9]?$/;

  const isInt = (v, a, b) => Number.isInteger(v) && v >= a && v <= b;
  const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n || 200);

  // قوانين الجدول المعتمدة كما في الأداة: المعتمَد صراحة، أو المضاف يدويًا ما لم يُرفض
  function approvedRules(cfg, settings) {
    const rs = (settings && settings.rules) || { approved: [], rejected: [], custom: [] };
    const all = (cfg.ruleCatalog || []).concat(rs.custom || []);
    return all.filter(r => (rs.approved || []).includes(r.id) || (!(rs.rejected || []).includes(r.id) && r.source === 'custom'));
  }

  function install(X) {
    const { op, tx, fail, audit, iso, uid, cleanName, deptIn, schoolIn, deptsOfSchool, teachersOf, bump, Engine, validateSchedulePayload, newDept, kuwaitToday, now, addScheduleVersion } = X;
    const getDb = X.db;

    // ---------- التخزين لكل مدرسة ----------
    const rowsOf = (d, sid) => (d.timetables || []).filter(r => r.schoolId === sid);
    const rowOf = (d, sid, kind, id) => (d.timetables || []).find(r => r.schoolId === sid && r.kind === kind && r.id === (id || 'main')) || null;
    function putRow(d, sid, kind, id, data, ctx) {
      if (!Array.isArray(d.timetables)) d.timetables = [];
      let r = rowOf(d, sid, kind, id);
      if (!r) { r = { schoolId: sid, kind, id: id || 'main', at: iso(), by: ctx ? ctx.name : null, data }; d.timetables.push(r); }
      else { r.at = iso(); r.by = ctx ? ctx.name : null; r.data = data; }
      return r;
    }
    const cfgOf = (d, sid) => { const r = rowOf(d, sid, 'config'); return r ? r.data : null; };
    const mapId = (cfg, id) => (cfg.idMap && cfg.idMap[id]) || id;

    // ---------- الصلاحيات ----------
    // المنظّم: كل المدارس؛ مدير المدرسة ومساعدوه: مدرستهم كاملة؛ المفوَّض: صلاحيات «جدول المدرسة» من تفويض سارٍ على المدرسة كاملة فقط.
    // رئيس القسم ونائبه لا يملكون شيئًا من ذلك تلقائيًا.
    function permsOf(ctx, sid) {
      if (ctx.role === 'admin') return new Set(TT_PERMS);
      if (ctx.role === 'school') return ctx.schoolId === sid ? new Set(TT_PERMS) : new Set();
      const out = new Set();
      for (const g of ctx.grants || []) if (g.schoolId === sid && g.allDepts) for (const k of g.perms) if (TT_PERMS.includes(k)) out.add(k);
      return out;
    }
    // المدرسة المطلوبة والتحقق من صلاحية العملية عليها (في الخادم، لا بإخفاء المربع فقط)
    function need(ctx, a, perm) {
      const d = getDb();
      let sid = a && typeof a.schoolId === 'string' ? a.schoolId : null;
      if (ctx.role === 'school') { if (sid && sid !== ctx.schoolId) fail('غير مصرح لك بالوصول إلى هذه المدرسة.', 'forbidden'); sid = ctx.schoolId; }
      if (ctx.role === 'head' && !sid) { const g = (ctx.grants || []).find(x => x.allDepts && TT_PERMS.some(k => x.perms.has(k))); sid = g ? g.schoolId : null; }
      const sc = sid ? schoolIn(d, sid) : null;
      if (!sc) fail(ctx.role === 'admin' ? 'المدرسة غير موجودة.' : 'غير مصرح لك بالوصول إلى جدول هذه المدرسة.', ctx.role === 'admin' ? 'not_found' : 'forbidden');
      const perms = permsOf(ctx, sid);
      if (perm && !perms.has(perm)) fail('هذه العملية على جدول المدرسة ليست ضمن صلاحياتك.', 'forbidden');
      if (ctx.role === 'head') { const g = (ctx.grants || []).find(x => x.schoolId === sid && x.allDepts && (!perm || x.perms.has(perm))); if (g) ctx.usedGrant = g; }
      return { sid, sc, perms };
    }
    const mgr = ctx => ctx.role === 'admin' || ctx.role === 'school';

    // ---------- بيانات الأداة من بيانات المدرسة ----------
    function rosterOf(d, sid, cfg) {
      const teachers = [], archived = [];
      for (const s of cfg.subjects) {
        const dep = deptIn(d, s.deptId); if (!dep || dep.schoolId !== sid) continue;
        const ts = teachersOf(d, dep.id).slice().sort((a, b) => (a.id === dep.headTeacherId ? -1 : b.id === dep.headTeacherId ? 1 : 0) || (a.rotationOrder - b.rotationOrder));
        for (const t of ts) {
          const x = { id: t.id, name: t.name, dept: s.name, role: t.id === dep.headTeacherId ? 'رئيس القسم' : 'معلم', head: t.id === dep.headTeacherId, secs: (t.ttSecs || []).filter(v => cfg.sections.includes(v)), note: t.ttNote || '' };
          if (t.ttPrintName) x.printName = t.ttPrintName;
          (t.status === 'active' ? teachers : archived).push(x);
        }
      }
      return { teachers, archived, rev: cfg.rosterRev || 0 };
    }
    // وضع الجدولة: «auto» الجدولة التلقائية (القوانين والقيود مفعّلة) أو «manual» جدول جاهز من Excel (القوانين محفوظة ومعطّلة)
    const modeOf = st => (st && st.mode === 'manual' ? 'manual' : 'auto');
    // دروس الجدول الجاهز المحفوظة في المسودة (بمعرّفات المعلمين الثابتة)
    const lessonsOf = (cfg, draft) => (draft && Array.isArray(draft.lessons) ? draft.lessons.map(x => ({ sec: x.sec, subj: x.subj, t: (x.t || []).map(id => mapId(cfg, String(id))), len: x.len === 2 ? 2 : 1 })) : null);
    function schoolObj(sc, cfg, roster, draft) {
      const lessons = lessonsOf(cfg, draft);
      return {
        ...(lessons ? { lessons } : {}),
        school: sc.name, days: cfg.days.map(k => DAY_AR[k]), periods: cfg.periods, breaks: cfg.breaks.slice(),
        ...(Array.isArray(cfg.dayPeriods) ? { dayPeriods: cfg.dayPeriods.slice() } : {}),
        sections: cfg.sections.slice(),
        subjects: cfg.subjects.map(s => ({ name: s.name, load: s.load, double: !!s.double, cap: s.cap || null, late: !!s.late, ...(s.capMsg ? { capMsg: s.capMsg } : {}), ...(s.facility ? { facility: s.facility } : {}) })),
        meetings: Object.fromEntries(cfg.subjects.map(s => [s.name, []])), noMeeting: (cfg.noMeeting || []).slice(),
        teachers: roster.teachers, ruleCatalog: (cfg.ruleCatalog || []).slice(), allowMissing: true
      };
    }

    // ---------- التحقق من الإعدادات ----------
    function cleanConfig(d, sid, c, prev) {
      if (!c || typeof c !== 'object') fail('إعدادات الجدول غير صالحة.');
      const days = Array.isArray(c.days) ? c.days.filter(k => DAY_KEYS.includes(k)) : [];
      if (!days.length || new Set(days).size !== days.length) fail('اختر أيام الدراسة.');
      const periods = Number(c.periods); if (!isInt(periods, 1, 12)) fail('عدد الحصص اليومية غير صالح (1–12).');
      const breaks = Array.from(new Set((Array.isArray(c.breaks) ? c.breaks : []).map(Number))).filter(n => isInt(n, 1, periods - 1)).sort((a, b) => a - b);
      const sections = Array.from(new Set((Array.isArray(c.sections) ? c.sections : []).map(x => str(x, 10)))).filter(Boolean);
      if (!sections.length) fail('لا توجد شعب.');
      if (sections.some(x => !SEC_RE.test(x))) fail('صيغة الشعبة: الصف-الرقم، مثل 8-2.');
      const subjects = (Array.isArray(c.subjects) ? c.subjects : []).map(s => {
        const name = cleanName(s && s.name, 'اسم المادة');
        const dep = deptIn(d, s.deptId); if (!dep || dep.schoolId !== sid) fail(`المادة «${name}» غير مرتبطة بقسم من أقسام هذه المدرسة.`);
        const load = Number(s.load); if (!isInt(load, 0, periods * days.length)) fail(`نصاب «${name}» لكل شعبة غير صالح.`);
        if (s.double && load % 2) fail(`نصاب «${name}» (${load}) فردي ولا يقسم إلى حصص مزدوجة.`);
        const cap = s.cap == null || s.cap === '' ? null : Number(s.cap); if (cap != null && !isInt(cap, 1, 99)) fail(`سعة «${name}» غير صالحة.`);
        return { name, deptId: dep.id, load, double: !!s.double, cap, late: !!s.late, ...(s.capMsg ? { capMsg: str(s.capMsg, 120) } : {}), ...(s.facility ? { facility: str(s.facility, 60) } : {}) };
      });
      if (!subjects.length) fail('لا توجد مواد.');
      if (new Set(subjects.map(s => s.name)).size !== subjects.length) fail('مادة مكررة.');
      if (new Set(subjects.map(s => s.deptId)).size !== subjects.length) fail('القسم مرتبط بأكثر من مادة.');
      const noMeeting = (Array.isArray(c.noMeeting) ? c.noMeeting : []).map(x => str(x, 80)).filter(n => subjects.some(s => s.name === n));
      const ruleCatalog = (Array.isArray(c.ruleCatalog) ? c.ruleCatalog : []).slice(0, 60).map(r => ({
        id: str(r.id, 40), subj: str(r.subj, 80), grades: (r.grades || []).map(x => str(x, 4)), sections: (r.sections || []).map(x => str(x, 10)),
        max: Number(r.max) || 1, maxDaysOver: r.maxDaysOver == null ? null : Number(r.maxDaysOver), source: str(r.source, 20), evidence: str(r.evidence, 400)
      })).filter(r => r.id && subjects.some(s => s.name === r.subj));
      return { days, periods, breaks, sections, subjects, noMeeting, ruleCatalog, rosterRev: (prev && prev.rosterRev) || 0, idMap: (prev && prev.idMap) || {} };
    }

    // ---------- المسودة والفحص ----------
    function normDraft(draft, cfg, roster) {
      const ids = roster.teachers.map(t => t.id);
      const y = Object.assign({}, draft);
      if (Array.isArray(draft.unavailIds)) y.unavail = draft.unavailIds.map(([id, ss]) => [ids.indexOf(mapId(cfg, id)), ss]).filter(([i]) => i >= 0);
      return y;
    }
    // فحص كامل بمحرك الأداة نفسه: الشروط الإلزامية وقوانين الجدول والتوقيت والإعفاء والاجتماعات
    function evaluate(d, sid) {
      const sc = schoolIn(d, sid), cfg = cfgOf(d, sid);
      const errors = [], warnings = [];
      if (!cfg) return { errors: ['لم تُضبط إعدادات جدول المدرسة بعد.'], hard: ['لم تُضبط إعدادات جدول المدرسة بعد.'], soft: [], warnings, cfg: null };
      const roster = rosterOf(d, sid, cfg);
      const sRow = rowOf(d, sid, 'settings'), settings = sRow ? sRow.data : {};
      const dRow = rowOf(d, sid, 'draft');
      const mode = modeOf(settings);
      // إعدادات وقوانين الجدول (الفرص والمزدوجة والمرافق والأولى/الأخيرة...) كما تطبقها الأداة نفسها
      const catalogRules = approvedRules(cfg, settings), hasRule = n => catalogRules.some(r => r.subj === n);
      const school = TTE.schoolWithSettings(schoolObj(sc, cfg, roster, dRow && dRow.data), settings, { hasRule });
      const M = TTE.buildModel(school);
      if (!dRow || !dRow.data || !Array.isArray(dRow.data.pos)) { errors.push('لا توجد مسودة محفوظة للجدول.'); return { errors, hard: errors.slice(), soft: [], warnings, cfg, roster, M, mode, notes: [] }; }
      const draft = dRow.data;
      if (draft.pos.length !== M.lessons.length || !Array.isArray(draft.meet) || draft.meet.length !== M.subj.length) {
        errors.push('المسودة المحفوظة لا تطابق بيانات المعلمين والشعب الحالية (تغيّر الإسناد أو الإعدادات بعد آخر حفظ). افتح «جدول المدرسة» وأكمل التوزيع ثم احفظ.');
        return { errors, hard: errors.slice(), soft: [], warnings, cfg, roster, M, draftRow: dRow, mode, notes: [] };
      }
      const st = TTE.createState(M);
      TTE.loadInto(st, normDraft(draft, cfg, roster));
      // نوعان من المشاكل: «أساسية» تمنع تحديد المعلم أو اليوم أو الحصة أو الصف (لا تُتجاوز)،
      // و«قابلة للتجاوز» (قوانين وشروط التوزيع والتعارضات المسجلة) يمكن اعتماد الجدول رغمها بموافقة صريحة.
      const HARD_TYPES = new Set(['نصاب', 'إسناد']);
      const seen = new Set(), notes = [], hard = [], soft = [];
      if (mode === 'manual') {
        // جدول جاهز: قوانين الجدولة والقيود والتفضيلات معطّلة؛ ما يظهره الفحص ملاحظات لا تمنع التفعيل.
        // يمنع التفعيل فقط ما يحول دون قراءة الجدول أو ربطه (معلم أو مادة غير موجودة، أو مسودة لا تطابق البيانات).
        TTE.applyEffective(st, TTE.effectiveRules(M, settings, { manual: true, catalogRules, hasRule }));
        for (const x of TTE.validate(st)) if (!seen.has(x.msg)) { seen.add(x.msg); notes.push(x.msg); }
      } else {
        const s2 = Object.assign({}, settings, { exempt: (settings.exempt || []).map(x => mapId(cfg, String(x))) });
        TTE.applyEffective(st, TTE.effectiveRules(M, s2, { catalogRules, hasRule }));
        for (const x of TTE.validate(st)) if (!seen.has(x.msg)) { seen.add(x.msg); errors.push(x.msg); (HARD_TYPES.has(x.type) ? hard : soft).push(HARD_TYPES.has(x.type) ? x.msg : { type: x.type, msg: x.msg }); }
      }
      for (const p of M.problems) if (!seen.has(p)) { seen.add(p); errors.push(p); hard.push(p); }
      for (const s of cfg.subjects) {
        const dep = deptIn(d, s.deptId);
        if (!dep) { const m = `القسم المرتبط بمادة «${s.name}» غير موجود.`; errors.push(m); hard.push(m); continue; }
        if (!dep.headTeacherId) warnings.push(`قسم ${dep.name}: لم يُحدَّد رئيس القسم (يلزم لتوزيع الاحتياط لاحقًا، ولا يمنع التفعيل).`);
        if (!dep.state || !dep.state.confirmed) warnings.push(`قسم ${dep.name}: لم تُعتمد الحالة الافتتاحية (الدين ونقطة الدور) بعد؛ يلزم قبل توزيع الاحتياط.`);
      }
      return { errors, hard, soft, warnings, cfg, roster, M, st, draftRow: dRow, settings, mode, notes };
    }
    // بصمة الموافقة: إصدار المسودة وقائمة المشاكل القابلة للتجاوز كما عُرضت. أي تغيير فيهما يتطلب موافقة جديدة.
    const ackHashOf = ev => { const txt = String(ev.draftRow ? ev.draftRow.data.rev || 0 : '') + '\u0001' + ev.soft.map(x => x.type + ':' + x.msg).join('\u0001'); let h = 2166136261; for (let i = 0; i < txt.length; i++) { h ^= txt.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return 'ack' + h.toString(16) + '_' + ev.soft.length; };
    // تحويل الجدول إلى جدول كل قسم بالبنية التي يستخدمها محرك الاحتياط: تدريس بالشعبة، واجتماع القسم التزامًا يمنع الاحتياط
    function deptPayloads(ev) {
      const { cfg, M, st } = ev, P = M.P;
      const dayLen = Array.isArray(cfg.dayPeriods) && cfg.dayPeriods.length === cfg.days.length ? cfg.dayPeriods : cfg.days.map(() => P);
      const periodsByDay = Object.fromEntries(cfg.days.map((k, i) => [k, Array.from({ length: dayLen[i] }, (_, n) => n + 1)]));
      const out = [];
      cfg.subjects.forEach((s, j) => {
        const tIdx = M.deptTeachers[j];
        const entries = [], busy = new Map();
        M.lessons.forEach((L, l) => {
          if (L.subj !== j || st.pos[l] < 0) return;
          for (let k = 0; k < L.len; k++) {
            const slot = st.pos[l] + k, day = cfg.days[Math.floor(slot / P)], period = slot % P + 1;
            for (const t of L.teachers) {
              // معلم في شعبتين بالحصة نفسها (جدول جاهز كما هو): خانة واحدة بالشعبتين، لا خانتان متعارضتان
              const prev = busy.get(t + '|' + slot);
              if (prev) { if (!prev.cls.split('، ').includes(M.secs[L.sec])) prev.cls += '، ' + M.secs[L.sec]; continue; }
              const e = { teacherId: M.T[t].id, day, period, type: 'teach', cls: M.secs[L.sec], raw: '', ref: 'tt' };
              entries.push(e); busy.set(t + '|' + slot, e);
            }
          }
        });
        // التزامات الجدول الجاهز (غير التدريس والاجتماع) كما وردت في الملف
        const tSet = new Set(tIdx.map(t => String(M.T[t].id)));
        for (const c of (ev.draftRow && ev.draftRow.data && ev.draftRow.data.commit) || []) {
          const [id, slot, type, raw] = c; const tid = mapId(cfg, String(id));
          if (!tSet.has(tid) || !Number.isInteger(slot) || slot < 0 || slot >= M.S) continue;
          const t = tIdx.find(x => String(M.T[x].id) === tid);
          if (busy.has(t + '|' + slot)) continue;
          const e = { teacherId: tid, day: cfg.days[Math.floor(slot / P)], period: slot % P + 1, type: String(type), cls: '', raw: String(raw || '').slice(0, 120), ref: 'tt' };
          entries.push(e); busy.set(t + '|' + slot, e);
        }
        // الجدول الجاهز: الاجتماع لمن ورد له في الملف فقط؛ وإن نُقل الموعد يدويًا بعد الاستيراد فلكل معلمي القسم
        const mt = ev.draftRow && ev.draftRow.data && Array.isArray(ev.draftRow.data.meetT) ? new Set(ev.draftRow.data.meetT.map(([id, sl]) => mapId(cfg, String(id)) + '|' + sl)) : null;
        for (const slot of Array.from(new Set(st.meet[j] || []))) {
          const day = cfg.days[Math.floor(slot / P)], period = slot % P + 1;
          const fromFile = mt && tIdx.some(t => mt.has(String(M.T[t].id) + '|' + slot));
          for (const t of tIdx) if (!busy.has(t + '|' + slot) && (!fromFile || mt.has(String(M.T[t].id) + '|' + slot))) { busy.set(t + '|' + slot, true); entries.push({ teacherId: M.T[t].id, day, period, type: 'meeting', cls: '', raw: 'اجتماع القسم', ref: 'tt' }); }
        }
        entries.sort((a, b) => (a.teacherId < b.teacherId ? -1 : a.teacherId > b.teacherId ? 1 : 0) || cfg.days.indexOf(a.day) - cfg.days.indexOf(b.day) || a.period - b.period);
        out.push({ deptId: s.deptId, subject: s.name, payload: { days: cfg.days.slice(), periodsByDay, teacherIds: tIdx.map(t => M.T[t].id), entries } });
      });
      return out;
    }
    // الجدول الساري لقسم في تاريخ (للمقارنة)
    const schedAt = X.schedAt;
    function compare(d, ev, date) {
      return deptPayloads(ev).map(x => {
        const dep = deptIn(d, x.deptId), cur = schedAt(dep, date);
        const key = e => [e.teacherId, e.day, e.period, e.type, e.cls || ''].join('|');
        const a = new Set((cur ? cur.entries : []).map(key)), b = new Set(x.payload.entries.map(key));
        const added = [...b].filter(k => !a.has(k)), removed = [...a].filter(k => !b.has(k));
        const touched = new Set(added.concat(removed).map(k => k.split('|')[0]));
        const nameOf = id => (d.teachers.find(t => t.id === id) || {}).name || id;
        const curIds = new Set(cur ? cur.teacherIds : []), newIds = new Set(x.payload.teacherIds);
        return {
          deptId: dep.id, deptName: dep.name, subject: x.subject,
          current: cur ? { version: cur.version, source: (cur.source && cur.source.kind) || 'excel', effectiveFrom: cur.effectiveFrom || null, teach: cur.entries.filter(e => e.type === 'teach').length, other: cur.entries.filter(e => e.type !== 'teach').length } : null,
          next: { teach: x.payload.entries.filter(e => e.type === 'teach').length, meetings: x.payload.entries.filter(e => e.type === 'meeting').length, teachers: x.payload.teacherIds.length },
          added: added.length, removed: removed.length, changedTeachers: [...touched].map(nameOf),
          joining: [...newIds].filter(id => !curIds.has(id)).map(nameOf), leaving: [...curIds].filter(id => !newIds.has(id)).map(nameOf)
        };
      });
    }
    function checkDate(d, sid, date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) fail('حدّد تاريخ بدء سريان الجدول.');
      const today = kuwaitToday(now());
      if (date < today) fail('تاريخ السريان لا يكون قبل اليوم.');
      const ids = new Set(deptsOfSchool(d, sid).map(x => x.id));
      const last = d.days.filter(x => ids.has(x.deptId) && x.date >= date).map(x => x.date).sort().pop();
      if (last) fail(`يوجد يوم احتياط معتمد بتاريخ ${last} في أحد أقسام المدرسة؛ اختر تاريخ سريان بعده حتى لا تتغير الأيام المعتمدة.`);
      return date;
    }

    // ---------- العمليات ----------
    const TT_ROLES = ['admin', 'school', 'head'];
    op('timetable.get', TT_ROLES, async (ctx, a) => {
      const d = getDb(); const { sid, sc, perms } = need(ctx, a, 'ttView');
      const cfg = cfgOf(d, sid);
      const deptInfo = x => {
        const ap = x.scheduleApproved;
        const o = { id: x.id, name: x.name, teachers: teachersOf(d, x.id).filter(t => t.status === 'active').length, days: ap ? ap.days.slice() : [], maxPeriod: ap ? Math.max(0, ...Object.values(ap.periodsByDay || {}).flat()) : 0 };
        // لمطابقة ملف المدرسة بسجلات المعلمين القائمة (إدارة المدرسة فقط)
        if (mgr(ctx)) o.teacherList = teachersOf(d, x.id).map(t => ({ id: t.id, name: t.name, status: t.status, head: t.id === x.headTeacherId, deputy: (x.deputyTeacherIds || []).includes(t.id) }));
        return o;
      };
      const base = { school: { id: sc.id, name: sc.name }, perms: TT_PERMS.filter(k => perms.has(k)), canSetup: mgr(ctx), depts: deptsOfSchool(d, sid).map(deptInfo) };
      const acts = rowsOf(d, sid).filter(r => r.kind === 'activation').map(r => ({ id: r.id, at: r.at, by: r.by, effectiveFrom: r.data.effectiveFrom, depts: r.data.depts.length, draftRev: r.data.draftRev, mode: r.data.mode || 'auto',
        withProblems: r.data.withProblems ? { count: r.data.withProblems.count, list: r.data.withProblems.list.slice(0, 200), ack: r.data.withProblems.ack } : null }));
      if (!cfg) { const sRow0 = rowOf(d, sid, 'settings'); return { ...base, configured: false, activations: acts, mode: modeOf(sRow0 && sRow0.data) }; }
      const roster = rosterOf(d, sid, cfg);
      const sRow = rowOf(d, sid, 'settings'), dRow = rowOf(d, sid, 'draft');
      const versions = rowsOf(d, sid).filter(r => r.kind === 'version').map(r => ({ id: r.id, ...r.data, by: r.by }));
      const imps = rowsOf(d, sid).filter(r => r.kind === 'import').map(r => ({ id: r.id, ...r.data }));
      return {
        ...base, configured: true, config: { ...cfg, idMap: undefined }, schoolObj: schoolObj(sc, cfg, roster, dRow && dRow.data), roster,
        settings: sRow ? sRow.data : null, settingsAt: sRow ? sRow.at : null, mode: modeOf(sRow && sRow.data),
        ready: dRow && Array.isArray(dRow.data.lessons) ? { file: dRow.data.importFile || null, at: dRow.data.importAt || null, undo: dRow.data.importUndo || null, lessons: dRow.data.lessons.length } : null,
        draft: dRow ? { data: dRow.data, at: dRow.at, by: dRow.by, rev: dRow.data.rev || 0, source: dRow.data.source || null } : null,
        versions, imports: imps, activations: acts
      };
    });
    // الإعداد الأول: الأقسام والمعلمون والشعب من ملف المدرسة بعد معاينة يعتمدها المستخدم، ثم إعدادات الجدول
    op('timetable.setup', ['admin', 'school'], async (ctx, a) => tx(d => {
      const { sid, sc } = need(ctx, a, 'ttDraft');
      if (cfgOf(d, sid) && !a.reconfigure) fail('إعدادات جدول المدرسة موجودة مسبقًا.', 'conflict');
      const plan = Array.isArray(a.depts) ? a.depts : [];
      if (!plan.length) fail('لا توجد أقسام في المعاينة.');
      const created = [], added = [], updated = [];
      const subjDept = {};
      for (const p of plan) {
        const name = cleanName(p.name, 'اسم القسم');
        let dep = p.deptId ? deptIn(d, p.deptId) : null;
        if (p.deptId && (!dep || dep.schoolId !== sid)) fail(`القسم «${name}» ليس من أقسام هذه المدرسة.`, 'forbidden');
        if (!dep) {
          if (deptsOfSchool(d, sid).some(x => x.name === name)) fail(`القسم «${name}» موجود في المدرسة؛ اربطه به بدل إنشاء قسم جديد.`);
          dep = newDept(d, ctx, name, sid, {}); created.push(name);
        }
        subjDept[name] = dep.id;
        const used = new Set();
        let headId = null;
        (Array.isArray(p.teachers) ? p.teachers : []).forEach((x, i) => {
          const secs = Array.from(new Set((x.secs || []).map(v => str(v, 10)))).filter(v => SEC_RE.test(v));
          let t = null;
          if (x.existingId) {
            t = d.teachers.find(y => y.id === x.existingId);
            if (!t || t.deptId !== dep.id) fail(`المعلم «${str(x.name, 80)}» ليس من معلمي قسم ${dep.name}.`);
            if (used.has(t.id)) fail(`المعلم «${t.name}» مكرر في المعاينة.`);
            if (JSON.stringify(t.ttSecs || []) !== JSON.stringify(secs)) { t.ttSecs = secs; updated.push(t.name); }
          } else {
            const nm = cleanName(x.name, 'اسم المعلم');
            if (teachersOf(d, dep.id).some(y => y.name === nm)) fail(`يوجد معلم بالاسم «${nm}» في قسم ${dep.name}؛ اربطه به بدل إضافته.`);
            const order = teachersOf(d, dep.id).reduce((m, y) => Math.max(m, y.rotationOrder), 0) + 1;
            t = { id: uid('t'), deptId: dep.id, name: nm, status: 'active', inRotation: true, rotationOrder: order, demo: false, createdAt: iso(), ttSecs: secs };
            d.teachers.push(t); added.push(nm);
          }
          used.add(t.id);
          if (x.head) { if (headId) fail(`قسم ${dep.name}: اختر رئيسًا واحدًا فقط.`); headId = t.id; }
        });
        if (headId && dep.headTeacherId !== headId) {
          if ((dep.deputyTeacherIds || []).includes(headId)) fail(`قسم ${dep.name}: المعلم المختار رئيسًا نائبٌ لرئيس القسم.`);
          const was = dep.headTeacherId ? (d.teachers.find(t => t.id === dep.headTeacherId) || {}).name : null;
          dep.headTeacherId = headId;
          audit(d, ctx, 'تحديد رئيس القسم من ملف المدرسة', `${(d.teachers.find(t => t.id === headId) || {}).name}${was ? ` (بدل ${was})` : ''}`, dep.id);
        }
        bump(dep);
      }
      const c0 = a.config || {};
      c0.subjects = (c0.subjects || []).map(s => ({ ...s, deptId: s.deptId || subjDept[s.name] }));
      const cfg = cleanConfig(d, sid, c0, cfgOf(d, sid));
      putRow(d, sid, 'config', 'main', cfg, ctx);
      if (!rowOf(d, sid, 'settings')) putRow(d, sid, 'settings', 'main', {
        methods: { tap: true, drag: true, pair: true, form: true }, rules: { approved: (cfg.ruleCatalog || []).filter(r => r.source === 'confirmed').map(r => r.id), rejected: [], custom: [] },
        printSchool: sc.name, printNames: true, timing: { last: [], subjects: {} }, meetings: null, exempt: [], savedAt: Date.now()
      }, ctx);
      audit(d, ctx, 'إعداد جدول المدرسة من ملف المعلمين والشعب', `أقسام جديدة: ${created.length}، معلمون جدد: ${added.length}، تحديث شعب: ${updated.length}`, null, { schoolId: sid });
      return { created, added, updated: updated.length };
    }));
    op('timetable.configSave', ['admin', 'school'], async (ctx, a) => tx(d => {
      const { sid } = need(ctx, a, 'ttDraft');
      const prev = cfgOf(d, sid); if (!prev) fail('اضبط إعدادات الجدول أولًا من ملف المدرسة.');
      const cfg = cleanConfig(d, sid, a.config, prev);
      putRow(d, sid, 'config', 'main', cfg, ctx);
      audit(d, ctx, 'تعديل إعدادات جدول المدرسة', `${cfg.subjects.length} مادة، ${cfg.sections.length} شعبة، ${cfg.periods} حصص`, null, { schoolId: sid });
      return { ok: true };
    }));
    // حفظ المسودة (الحفظ التلقائي في الأداة). لا يمس جداول الاحتياط المعتمدة.
    op('timetable.draftSave', TT_ROLES, async (ctx, a) => tx(d => {
      const { sid, perms } = need(ctx, a, 'ttDraft');
      const cfg = cfgOf(d, sid); if (!cfg) fail('اضبط إعدادات الجدول أولًا.');
      const x = a.data || {};
      if (!Array.isArray(x.pos) || x.pos.length > 20000 || x.pos.some(v => !Number.isInteger(v) || v < -1 || v > 1000)) fail('بيانات المسودة غير صالحة.');
      if (!Array.isArray(x.meet) || x.meet.length !== cfg.subjects.length) fail('بيانات اجتماعات الأقسام غير صالحة.');
      if (a.source === 'generate' && !perms.has('ttGenerate')) fail('توليد الجدول ليس ضمن صلاحياتك.', 'forbidden');
      const cur = rowOf(d, sid, 'draft');
      const rev = cur && cur.data ? cur.data.rev || 0 : 0;
      if (a.baseRev != null && a.baseRev !== rev) fail('عدّل مستخدم آخر مسودة الجدول بعد فتحك لها. حدّث الصفحة لترى آخر نسخة.', 'conflict');
      const unavailIds = (Array.isArray(x.unavailIds) ? x.unavailIds : []).map(([id, ss]) => [mapId(cfg, String(id)), (ss || []).map(Number).filter(v => Number.isInteger(v))]);
      const data = { pos: x.pos, meet: x.meet.map(m => (m || []).map(Number)), unavail: x.unavail || [], unavailIds, rosterRev: cfg.rosterRev || 0, savedAt: Date.now(), schema: 2, rev: rev + 1, source: a.source === 'generate' ? 'generate' : 'edit' };
      // الجدول الجاهز: الدروس والالتزامات ثابتة من الاستيراد (لا يغيّرها الحفظ)، والحفظ يغيّر الأوقات فقط
      const cd = cur && cur.data;
      if (cd && Array.isArray(cd.lessons)) {
        if (x.pos.length !== cd.lessons.length) fail('المسودة المرسلة لا تطابق دروس الجدول الجاهز المحفوظ. حدّث الصفحة.', 'conflict');
        Object.assign(data, { schema: 3, lessons: cd.lessons, commit: cd.commit || [], meetT: cd.meetT || [], importFile: cd.importFile || null, importAt: cd.importAt || null, importUndo: cd.importUndo || null });
      }
      putRow(d, sid, 'draft', 'main', data, ctx);
      if (a.source === 'generate') audit(d, ctx, 'توليد مسودة جدول المدرسة', '', null, { schoolId: sid });
      return { rev: data.rev };
    }));
    op('timetable.settingsSave', TT_ROLES, async (ctx, a) => tx(d => {
      const { sid } = need(ctx, a, 'ttDraft');
      const cfg = cfgOf(d, sid); if (!cfg) fail('اضبط إعدادات الجدول أولًا.');
      const x = a.data || {};
      const data = {
        methods: x.methods || {}, rules: x.rules || { approved: [], rejected: [], custom: [] }, printSchool: str(x.printSchool, 80), printNames: x.printNames !== false,
        timing: x.timing || null, meetings: x.meetings || null, exempt: (Array.isArray(x.exempt) ? x.exempt : []).map(v => mapId(cfg, String(v))), savedAt: Date.now()
      };
      if (x.print && typeof x.print === 'object') data.print = { fl: x.print.fl !== false, quality: x.print.quality === 'veryhigh' ? 'veryhigh' : 'high', paper: ['A4', 'A3', 'full'].includes(x.print.paper) ? x.print.paper : 'A4' };
      const prevS = rowOf(d, sid, 'settings');
      if (prevS && prevS.data && prevS.data.mode) data.mode = prevS.data.mode; // الوضع يُغيَّر من مفتاح «الجدولة التلقائية» فقط
      // إعدادات وقوانين الجدول: تُوحَّد مع الافتراضية، ويُرفض حفظ حد أدنى أكبر من الأقصى (عامًا أو لقسم أو لمعلم)
      const roster = rosterOf(d, sid, cfg), base = schoolObj(schoolIn(d, sid), cfg, roster, (rowOf(d, sid, 'draft') || {}).data);
      const catalogRules = approvedRules(cfg, data), hasRule = n => catalogRules.some(r => r.subj === n);
      if (x.rc != null) {
        const rc = TTE.normRc(x.rc, base, { hasRule });
        const idOk = id => roster.teachers.some(t => t.id === id) || (roster.archived || []).some(t => t.id === id);
        rc.curr.t = Object.fromEntries(Object.entries(rc.curr.t).map(([k, v]) => [mapId(cfg, k), v]).filter(([k]) => idOk(k)));
        rc.fl.t = Object.fromEntries(Object.entries(rc.fl.t).map(([k, v]) => [mapId(cfg, k), v]).filter(([k]) => idOk(k)));
        rc.heads.except = rc.heads.except.map(k => mapId(cfg, k)).filter(idOk); rc.meet.admin.extra = rc.meet.admin.extra.map(k => mapId(cfg, k)).filter(idOk);
        data.rc = rc;
        const M = TTE.buildModel(TTE.schoolWithSettings(base, data, { hasRule }));
        const pr = TTE.rcProblems(M, data, { catalogRules, hasRule });
        if (pr.errors.length) fail('لا يمكن حفظ الإعدادات: ' + pr.errors.slice(0, 3).join(' '));
      } else if (prevS && prevS.data && prevS.data.rc) data.rc = prevS.data.rc;
      // الدراسات العملية: التخصص بمعرّف المعلم (معلمو القسم فقط)، والمنهج لكل صف وفصل، والتقسيم، وإسناد المجموعات لكل فصل.
      // الفصل المعروض يُغيَّر من «تبديل الفصل الدراسي» فقط (لا يُستبدل جدول الفصل الآخر بحفظ الإعدادات)
      if (x.prac != null) {
        const pr = TTE.normPrac(x.prac, base), prev = prevS && prevS.data && prevS.data.prac;
        pr.sem = prev && prev.sem === 2 ? 2 : 1;
        const ps = cfg.subjects.find(z => z.name === pr.subj), pIds = new Set(ps ? roster.teachers.filter(t => t.dept === ps.name).map(t => t.id) : []);
        pr.spec = Object.fromEntries(Object.entries(pr.spec).map(([k, v]) => [mapId(cfg, k), v]).filter(([k]) => pIds.has(k)));
        for (const sm of [1, 2]) pr.assign[sm] = Object.fromEntries(Object.entries(pr.assign[sm]).filter(([sec]) => cfg.sections.includes(sec)).map(([sec, ids]) => [sec, [...new Set(ids.map(k => mapId(cfg, k)))].filter(k => pIds.has(k))]).filter(([, ids]) => ids.length));
        data.prac = pr;
      } else if (prevS && prevS.data && prevS.data.prac) data.prac = prevS.data.prac;
      if (JSON.stringify(data).length > 200000) fail('حجم الإعدادات أكبر من المسموح.');
      putRow(d, sid, 'settings', 'main', data, ctx);
      return { ok: true };
    }));
    /* تبديل الفصل الدراسي المعروض: جدول كل فصل يُحفظ مستقلًا. تُحفظ مسودة الفصل الحالي في سطر الفصل، وتُحمَّل مسودة الفصل الآخر
       (أو تبدأ من نسخة من المسودة الحالية بالمواضع نفسها إن لم يوجد له جدول بعد، ثم تظهر مخالفات التخصص والورش دون إصلاح تلقائي) */
    op('timetable.semesterSwitch', TT_ROLES, async (ctx, a) => tx(d => {
      const { sid } = need(ctx, a, 'ttDraft');
      const cfg = cfgOf(d, sid); if (!cfg) fail('اضبط إعدادات الجدول أولًا.');
      const to = a.to === 2 ? 2 : a.to === 1 ? 1 : null; if (!to) fail('الفصل الدراسي غير معروف.');
      const sRow = rowOf(d, sid, 'settings'); if (!sRow) fail('احفظ إعدادات الجدول أولًا.');
      const cur = sRow.data.prac && sRow.data.prac.sem === 2 ? 2 : 1;
      if (cur === to) return { sem: to, same: true };
      const dr = rowOf(d, sid, 'draft');
      const rev = dr && dr.data ? dr.data.rev || 0 : 0;
      if (a.baseRev != null && a.baseRev !== rev) fail('تغيّرت مسودة الجدول من جهاز آخر. حدّث الصفحة ثم أعد المحاولة.', 'conflict');
      if (dr && dr.data) putRow(d, sid, 'draft', 'sem' + cur, JSON.parse(JSON.stringify(dr.data)), ctx);
      const other = rowOf(d, sid, 'draft', 'sem' + to);
      let started = false;
      if (other && other.data) putRow(d, sid, 'draft', 'main', Object.assign(JSON.parse(JSON.stringify(other.data)), { rev: rev + 1, savedAt: Date.now() }), ctx);
      else if (dr && dr.data) { started = true; putRow(d, sid, 'draft', 'main', Object.assign(JSON.parse(JSON.stringify(dr.data)), { rev: rev + 1, savedAt: Date.now(), source: 'semester-copy' }), ctx); }
      const prac = Object.assign({}, TTE.normPrac(sRow.data.prac, { sections: cfg.sections }), { sem: to });
      putRow(d, sid, 'settings', 'main', Object.assign({}, sRow.data, { prac }), ctx);
      audit(d, ctx, `عرض جدول الفصل الدراسي ${to === 2 ? 'الثاني' : 'الأول'}`, started ? 'لا يوجد جدول محفوظ لهذا الفصل؛ بدأ من نسخة من جدول الفصل الآخر بالمواضع نفسها، ومخالفات التخصص والورش ظاهرة دون إصلاح تلقائي' : `جدول الفصل ${cur === 2 ? 'الثاني' : 'الأول'} محفوظ كما هو`, null, { schoolId: sid });
      return { sem: to, started, rev: rev + 1 };
    }));
    op('timetable.versionAdd', TT_ROLES, async (ctx, a) => tx(d => {
      const { sid } = need(ctx, a, 'ttDraft');
      const cfg = cfgOf(d, sid); if (!cfg) fail('اضبط إعدادات الجدول أولًا.');
      const x = a.data || {};
      if (!Array.isArray(x.pos)) fail('النسخة غير صالحة.');
      const id = uid('ttv');
      const data = { name: str(x.name, 120), pos: x.pos, meet: x.meet, unavail: x.unavail || [], unavailIds: (x.unavailIds || []).map(([i, s]) => [mapId(cfg, String(i)), s]), roster: { rev: cfg.rosterRev || 0 }, savedAt: Date.now(), valid: !!x.valid };
      const dr = rowOf(d, sid, 'draft');
      if (dr && Array.isArray(dr.data.lessons) && x.pos.length === dr.data.lessons.length) { data.lessons = dr.data.lessons; data.commit = dr.data.commit || []; data.meetT = dr.data.meetT || []; }
      putRow(d, sid, 'version', id, data, ctx);
      const vs = rowsOf(d, sid).filter(r => r.kind === 'version').sort((p, q) => p.data.savedAt - q.data.savedAt);
      while (vs.length > MAX_VERSIONS) { const old = vs.shift(); d.timetables.splice(d.timetables.indexOf(old), 1); }
      return { id };
    }));
    op('timetable.importBackup', TT_ROLES, async (ctx, a) => tx(d => {
      const { sid } = need(ctx, a, 'ttDraft');
      const id = str(a.id, 60); if (!/^[A-Za-z0-9_-]+$/.test(id)) fail('معرّف غير صالح.');
      const cur = rowOf(d, sid, 'import', id);
      const data = Object.assign({}, cur ? cur.data : {}, a.data || {});
      if (JSON.stringify(data).length > 600000) fail('النسخة الاحتياطية أكبر من المسموح.');
      putRow(d, sid, 'import', id, data, ctx);
      const im = rowsOf(d, sid).filter(r => r.kind === 'import').sort((p, q) => (p.data.at || 0) - (q.data.at || 0));
      while (im.length > MAX_IMPORTS) { const old = im.shift(); d.timetables.splice(d.timetables.indexOf(old), 1); }
      return { ok: true };
    }));
    /* تحديث المعلمين وإسناد الشعب من الأداة (استيراد Excel أو أسماء الطباعة). يكتب في سجلات المعلمين الحالية نفسها:
       لا يُنشأ معلم مكرر، والمغادر يُؤرشف (يبقى سجله ودينه)، ولا يُنقل معلم بين الأقسام بصمت. */
    op('timetable.rosterApply', TT_ROLES, async (ctx, a) => tx(d => {
      const { sid } = need(ctx, a, 'ttDraft');
      const cfg = cfgOf(d, sid); if (!cfg) fail('اضبط إعدادات الجدول أولًا.');
      const inT = Array.isArray(a.teachers) ? a.teachers : null; if (!inT) fail('قائمة المعلمين غير صالحة.');
      const inA = Array.isArray(a.archived) ? a.archived : [];
      const cur = rosterOf(d, sid, cfg);
      const deptOfSubj = Object.fromEntries(cfg.subjects.map(s => [s.name, deptIn(d, s.deptId)]));
      const schoolT = id => { const t = d.teachers.find(x => x.id === id); return t && cfg.subjects.some(s => s.deptId === t.deptId) ? t : null; };
      const resolveT = id => schoolT(id) || schoolT(cfg.idMap && cfg.idMap[id]);
      // أسماء الطباعة فقط: متاحة لمن يعدّل المسودة؛ غير ذلك (إضافة، أرشفة، إسناد، رئيس قسم) لإدارة المدرسة
      const onlyPrint = inT.length === cur.teachers.length && inT.every(x => { const t = resolveT(String(x.id)); const c = t && cur.teachers.find(y => y.id === t.id); return c && c.name === x.name && c.dept === x.dept && JSON.stringify(c.secs) === JSON.stringify((x.secs || []).filter(v => cfg.sections.includes(v))) && !!c.head === !!x.head; });
      if (!onlyPrint && !mgr(ctx)) fail('تحديث المعلمين وإسناد الشعب من صلاحيات مدير النظام وإدارة المدرسة.', 'forbidden');
      const ch = { added: [], archived: [], secs: 0, renamed: [], heads: [], print: 0 };
      const touchedDeps = new Set(), seen = new Set(), headOf = {};
      for (const x of inT) {
        const dep = deptOfSubj[x.dept]; if (!dep) fail(`القسم «${str(x.dept, 80)}» غير مرتبط بمادة في إعدادات الجدول.`);
        const secs = Array.from(new Set((x.secs || []).map(v => str(v, 10)))).filter(v => cfg.sections.includes(v));
        let t = resolveT(String(x.id));
        if (t && t.deptId !== dep.id) fail(`المعلم «${t.name}» في قسم آخر في الموقع. نقل المعلم بين الأقسام لا يتم من الجدول؛ راجع إدارة المدرسة.`);
        if (!t) {
          const nm = cleanName(x.name, 'اسم المعلم');
          const same = teachersOf(d, dep.id).find(y => y.name === nm);
          if (same) t = same; // الاسم نفسه في القسم نفسه: السجل نفسه، لا تكرار
          else {
            const order = teachersOf(d, dep.id).reduce((m, y) => Math.max(m, y.rotationOrder), 0) + 1;
            t = { id: uid('t'), deptId: dep.id, name: nm, status: 'active', inRotation: true, rotationOrder: order, demo: false, createdAt: iso() };
            d.teachers.push(t); ch.added.push(nm); touchedDeps.add(dep.id);
            audit(d, ctx, 'إضافة معلم من جدول المدرسة', nm, dep.id);
          }
          cfg.idMap = Object.assign({}, cfg.idMap, { [String(x.id)]: t.id });
        }
        if (seen.has(t.id)) fail(`المعلم «${t.name}» مكرر.`);
        seen.add(t.id);
        if (t.status !== 'active') { t.status = 'active'; touchedDeps.add(dep.id); audit(d, ctx, 'إعادة تفعيل معلم من جدول المدرسة', t.name, dep.id); }
        const nm = str(x.name, 120);
        if (nm && nm !== t.name) { if (teachersOf(d, dep.id).some(y => y.id !== t.id && y.name === nm)) fail(`يوجد معلم بالاسم «${nm}».`); ch.renamed.push(`${t.name} ← ${nm}`); audit(d, ctx, 'تعديل اسم معلم من جدول المدرسة', `${t.name} ← ${nm}`, dep.id); t.name = nm; }
        if (JSON.stringify(t.ttSecs || []) !== JSON.stringify(secs)) { t.ttSecs = secs; ch.secs++; }
        const pn = str(x.printName, 120);
        if ((t.ttPrintName || '') !== pn) { if (pn) t.ttPrintName = pn; else delete t.ttPrintName; ch.print++; }
        const note = str(x.note, 200); if ((t.ttNote || '') !== note) { if (note) t.ttNote = note; else delete t.ttNote; }
        if (x.head) { if (headOf[dep.id]) fail(`قسم ${dep.name}: أكثر من رئيس قسم في القائمة.`); headOf[dep.id] = t.id; }
      }
      for (const [depId, hid] of Object.entries(headOf)) {
        const dep = deptIn(d, depId);
        if (dep.headTeacherId !== hid) {
          if ((dep.deputyTeacherIds || []).includes(hid)) fail(`قسم ${dep.name}: المعلم المختار رئيسًا نائبٌ لرئيس القسم.`);
          dep.headTeacherId = hid; touchedDeps.add(depId); ch.heads.push(dep.name);
          audit(d, ctx, 'تغيير رئيس القسم من جدول المدرسة', (d.teachers.find(t => t.id === hid) || {}).name || '', depId);
        }
      }
      // المغادرون المعتمدون في المعاينة: أرشفة (يُحفظ السجل والدين)
      for (const x of inA) {
        const t = resolveT(String(x.id)); if (!t || seen.has(t.id) || t.status !== 'active') continue;
        const dep = deptIn(d, t.deptId);
        if (dep.headTeacherId === t.id) fail(`«${t.name}» رئيس قسم ${dep.name}؛ عيّن رئيسًا آخر قبل أرشفته.`);
        if ((dep.deputyTeacherIds || []).includes(t.id)) fail(`«${t.name}» نائب لرئيس قسم ${dep.name}؛ أزل صلاحية النائب أولًا ثم أرشفه.`);
        if (dep.state && dep.state.pointer === t.id && t.inRotation) fail(`«${t.name}» نقطة الدور الحالية في قسم ${dep.name}؛ لا يُؤرشف الآن.`);
        t.status = 'archived'; ch.archived.push(t.name); touchedDeps.add(dep.id);
        audit(d, ctx, 'أرشفة معلم من جدول المدرسة (يُحفظ السجل والدين)', t.name, dep.id);
      }
      for (const id of touchedDeps) bump(deptIn(d, id));
      cfg.rosterRev = (cfg.rosterRev || 0) + 1;
      putRow(d, sid, 'config', 'main', cfg, ctx);
      if (ch.secs || ch.added.length || ch.archived.length || ch.heads.length) audit(d, ctx, 'تحديث معلمي جدول المدرسة وإسناد الشعب', `جدد: ${ch.added.length}، مؤرشفون: ${ch.archived.length}، تغيير شعب: ${ch.secs}، رؤساء أقسام: ${ch.heads.length}`, null, { schoolId: sid });
      return { rosterRev: cfg.rosterRev, idMap: cfg.idMap, changes: ch };
    }));
    op('timetable.activatePreview', TT_ROLES, async (ctx, a) => {
      const d = getDb(); const { sid } = need(ctx, a, 'ttApprove');
      const date = checkDate(d, sid, a.effectiveFrom);
      const ev = evaluate(d, sid);
      const cmp = ev.hard.length ? [] : compare(d, ev, date);
      return { effectiveFrom: date, errors: ev.errors.slice(0, 80), errorCount: ev.errors.length, warnings: ev.warnings, depts: cmp,
        hard: ev.hard.slice(0, 80), hardCount: ev.hard.length, soft: ev.soft.slice(0, 300), softCount: ev.soft.length, ackHash: ev.soft.length && !ev.hard.length ? ackHashOf(ev) : null, draftRev: ev.draftRow ? ev.draftRow.data.rev || 0 : null, draftAt: ev.draftRow ? ev.draftRow.at : null,
        mode: ev.mode, notes: (ev.notes || []).slice(0, 80), noteCount: (ev.notes || []).length, ready: !!(ev.draftRow && Array.isArray(ev.draftRow.data.lessons)) };
    });
    // «اعتماد الجدول وتفعيله للاحتياط»: إصدار جديد لجدول كل قسم بتاريخ سريان، دون تغيير الدين أو الدور أو إعدادات الأقسام أو الأيام المعتمدة
    op('timetable.activate', TT_ROLES, async (ctx, a) => tx(d => {
      const { sid } = need(ctx, a, 'ttApprove');
      const date = checkDate(d, sid, a.effectiveFrom);
      const ev = evaluate(d, sid);
      if (ev.hard.length) fail(`لا يمكن الاعتماد ولا التجاوز: ${ev.hard.length} مشكلة أساسية تمنع تحديد المعلم أو اليوم أو الحصة أو الصف (مثل: ${ev.hard[0]}). صحّحها في «جدول المدرسة» أولًا.`, 'conflict');
      if (a.draftRev != null && ev.draftRow && a.draftRev !== (ev.draftRow.data.rev || 0)) fail('تغيّرت المسودة بعد المعاينة. أعد المعاينة ثم الاعتماد.', 'conflict');
      // مشاكل قابلة للتجاوز: الاعتماد فقط بموافقة صريحة على القائمة نفسها التي عُرضت
      let withProblems = null;
      if (ev.soft.length) {
        if (a.override !== true) fail(`لا يمكن التفعيل: ${ev.soft.length} مشكلة في المسودة (مثل: ${ev.soft[0].msg}). يمكن الاعتماد رغمها بعد الاطلاع والموافقة الصريحة.`, 'needs_override');
        if (a.ackHash !== ackHashOf(ev)) fail('تغيّر الجدول أو قائمة مشاكله بعد عرض الموافقة. أعد الفحص واطّلع على القائمة المحدثة ثم وافق من جديد.', 'stale_ack');
        withProblems = { count: ev.soft.length, list: ev.soft.slice(0, 1000), ack: { by: ctx.name, role: ctx.role === 'admin' ? 'admin' : ctx.kind, at: iso(), hash: a.ackHash, text: 'اطلعت على المشاكل المذكورة، وأوافق على اعتماد الجدول وتفعيله للاحتياط رغم وجودها' } };
      }
      const id = uid('tta'), done = [];
      for (const x of deptPayloads(ev)) {
        const dep = deptIn(d, x.deptId);
        const ids = new Set(teachersOf(d, dep.id).map(t => t.id));
        const clean = validateSchedulePayload(x.payload, ids);
        const cur = Math.max(0, ...(dep.scheduleVersions || []).map(v => v.version), dep.scheduleApproved ? dep.scheduleApproved.version : 0);
        // قسم يعمل بجدوله الداخلي دون اختيار محفوظ: يُثبَّت مصدره «الجدول الداخلي» فلا يستبدله تفعيل جدول المدرسة بصمت
        if (!(dep.schedSource || []).length && X.srcNow) {
          const today = kuwaitToday(now()), was = X.srcNow(dep, today).source;
          if (was === 'internal') {
            dep.schedSource = [{ source: 'internal', from: today, at: iso(), by: ctx.name, byRole: ctx.role === 'admin' ? 'admin' : ctx.kind, prev: null, implicit: true }];
            audit(d, ctx, 'تثبيت مصدر جدول القسم', 'الجدول الداخلي — بقي مصدر القسم كما هو عند تفعيل جدول المدرسة (يمكن اختيار «الإدارة» من صفحة جدول القسم)', dep.id);
          }
        }
        const v = { version: cur + 1, approvedAt: iso(), approvedBy: ctx.name, ...clean, source: { kind: 'school-timetable', activationId: id, draftRev: ev.draftRow.data.rev || 0, note: withProblems ? `من «جدول المدرسة» — معتمد مع مشاكل (${withProblems.count})` : ev.mode === 'manual' ? 'من «جدول المدرسة» — جدول جاهز (قوانين الجدولة معطّلة)' : 'من «جدول المدرسة» بعد الفحص', ...(withProblems ? { withProblems: withProblems.count } : {}) }, effectiveFrom: date };
        addScheduleVersion(dep, v);
        if (X.ittAfterAdmin) X.ittAfterAdmin(d, dep, v, ctx);
        bump(dep);
        audit(d, ctx, 'تفعيل جدول المدرسة للاحتياط', `الإصدار ${v.version} يسري من ${date} (${clean.entries.filter(e => e.type === 'teach').length} حصة تدريس)`, dep.id);
        done.push({ deptId: dep.id, version: v.version });
      }
      putRow(d, sid, 'activation', id, { effectiveFrom: date, draftRev: ev.draftRow.data.rev || 0, depts: done, draft: ev.draftRow.data, settings: ev.settings || null, config: { ...ev.cfg, idMap: undefined }, warnings: ev.warnings, mode: ev.mode, notes: (ev.notes || []).length, ...(withProblems ? { withProblems } : {}) }, ctx);
      audit(d, ctx, withProblems ? 'اعتماد جدول المدرسة وتفعيله للاحتياط مع مشاكل' : 'اعتماد جدول المدرسة وتفعيله للاحتياط', `يسري من ${date} لـ${done.length} قسم — إصدار المسودة ${ev.draftRow.data.rev || 0}${withProblems ? ` — معتمد مع ${withProblems.count} مشكلة بموافقة صريحة (مثل: ${withProblems.list[0].msg})` : ''}${ev.mode === 'manual' ? ' — جدول جاهز من Excel (قوانين الجدولة معطّلة)' : ''}`, null, { schoolId: sid, ...(withProblems ? { problems: withProblems.count } : {}) });
      return { id, effectiveFrom: date, depts: done, withProblems: withProblems ? withProblems.count : 0 };
    }));
    // ---------- وضع الجدولة: تشغيل «الجدولة التلقائية» أو إيقافها (جدول جاهز من Excel) ----------
    const defaultSettings = (cfg, sc) => ({
      methods: { tap: true, drag: true, pair: true, form: true }, rules: { approved: ((cfg && cfg.ruleCatalog) || []).filter(r => r.source === 'confirmed').map(r => r.id), rejected: [], custom: [] },
      printSchool: sc.name, printNames: true, timing: { last: [], subjects: {} }, meetings: null, exempt: [], savedAt: Date.now()
    });
    // الإيقاف لا يحذف القوانين ولا الجدول: يحفظ الوضع فقط، والقوانين المحفوظة تعود عند التشغيل
    op('timetable.modeSet', TT_ROLES, async (ctx, a) => tx(d => {
      const { sid, sc } = need(ctx, a, 'ttDraft');
      const mode = a.mode === 'manual' ? 'manual' : a.mode === 'auto' ? 'auto' : null;
      if (!mode) fail('الوضع غير معروف.');
      const r = rowOf(d, sid, 'settings');
      const data = Object.assign({}, r ? r.data : defaultSettings(cfgOf(d, sid), sc), { mode });
      putRow(d, sid, 'settings', 'main', data, ctx);
      audit(d, ctx, mode === 'auto' ? 'تشغيل الجدولة التلقائية لجدول المدرسة' : 'إيقاف الجدولة التلقائية — جدول جاهز من Excel', mode === 'auto' ? 'قوانين الجدولة والقيود والتفضيلات المحفوظة مفعّلة من جديد؛ الجدول الحالي لم يتغير' : 'قوانين الجدولة والقيود والتفضيلات محفوظة ومعطّلة؛ الجدول الحالي لم يتغير', null, { schoolId: sid });
      return { mode };
    }));

    // ---------- استيراد جدول أسبوعي جاهز من Excel ----------
    // بيانات المطابقة: أقسام المدرسة بمعلميها (لإدارة المدرسة؛ إنشاء المعلمين والأقسام من صلاحياتها)
    op('timetable.importContext', ['admin', 'school'], async (ctx, a) => {
      const d = getDb(); const { sid, sc } = need(ctx, a, 'ttDraft');
      return {
        school: { id: sc.id, name: sc.name }, profile: null,
        depts: deptsOfSchool(d, sid).map(dep => ({
          id: dep.id, name: dep.name, status: dep.status, headTeacherId: dep.headTeacherId || null,
          approved: null, scheduleVersion: dep.scheduleApproved ? dep.scheduleApproved.version : 0,
          teachers: teachersOf(d, dep.id).map(t => ({ id: t.id, name: t.name, status: t.status, inRotation: t.inRotation, isHead: dep.headTeacherId === t.id }))
        }))
      };
    });
    const SEC_IN = /^\s*(\d{1,2})\s*[\/\\\-–]\s*(\d{1,2})\s*$/;
    const secOf = v => { const m = SEC_IN.exec(String(v == null ? '' : v)); return m && +m[1] > 0 && +m[2] > 0 ? `${+m[1]}-${+m[2]}` : null; };
    /* الاعتماد: الجدول كما ورد في الملف بعد المعاينة. لا يُرفض لمخالفة قوانين الجدولة؛ يُرفض فقط ما يمنع القراءة أو الربط.
       - الأقسام والمعلمون: ربط بالسجلات القائمة دون تكرار (لا يُنقل معلم بين الأقسام)، أو إنشاء جديد.
       - المسودة تُستبدل بالجدول المستورد بعد نسخة احتياطية تلقائية (يمكن التراجع)، ولا يتغير جدول الاحتياط إلا بالتفعيل.
       - لا تُغيَّر أوقات الحصص ولا الإسناد ولا ترتيب الجدول. */
    op('timetable.importReady', ['admin', 'school'], async (ctx, a) => tx(d => {
      const { sid, sc } = need(ctx, a, 'ttDraft');
      const groups = Array.isArray(a.depts) ? a.depts : [];
      if (!groups.length) fail('لا توجد أقسام في الجدول المستورد.');
      if (groups.length > 60) fail('عدد الأقسام أكبر من المسموح.');
      const cur = rowOf(d, sid, 'draft');
      const rev = cur && cur.data ? cur.data.rev || 0 : 0;
      if (a.baseRev != null && a.baseRev !== rev) fail('تغيّرت مسودة الجدول منذ فتح الاستيراد. ارجع إلى «جدول المدرسة» ثم أعد الاستيراد.', 'conflict');
      const prevCfg = cfgOf(d, sid);
      // 1) الأقسام والمعلمين
      const created = [], added = [], revived = [], used = new Set(), linked = [];
      const resolved = [];
      for (const g of groups) {
        let dep = null;
        if (g.deptId) { dep = deptIn(d, g.deptId); if (!dep || dep.schoolId !== sid) fail('قسم مرتبط ليس من أقسام هذه المدرسة.', 'forbidden'); }
        else {
          const name = cleanName(g.newName, 'اسم القسم');
          if (deptsOfSchool(d, sid).some(x => x.name === name)) fail(`القسم «${name}» موجود في المدرسة؛ اربط المجموعة به بدل إنشاء قسم جديد.`);
          dep = newDept(d, ctx, name, sid, {}); created.push(name);
        }
        if (resolved.some(x => x.dep.id === dep.id)) fail(`القسم «${dep.name}» مربوط بأكثر من مجموعة في الملف.`);
        const keyMap = new Map();
        for (const t of Array.isArray(g.teachers) ? g.teachers : []) {
          const key = String((t && t.key) || ''); if (!key || keyMap.has(key)) fail('بيانات المعلمين غير صالحة (مفتاح مكرر أو فارغ).');
          let rec = null;
          if (t.teacherId) {
            rec = d.teachers.find(x => x.id === t.teacherId);
            if (!rec || rec.deptId !== dep.id) fail(`المعلم «${str(t.name, 80)}» مرتبط بسجل ليس من قسم «${dep.name}». لا يُنقل المعلم بين الأقسام؛ راجع الربط.`);
          } else {
            const nm = cleanName(t.name, 'اسم المعلم');
            rec = teachersOf(d, dep.id).find(x => x.name === nm) || null; // الاسم نفسه في القسم نفسه: السجل نفسه
            if (!rec) {
              const order = teachersOf(d, dep.id).reduce((m, y) => Math.max(m, y.rotationOrder), 0) + 1;
              rec = { id: uid('t'), deptId: dep.id, name: nm, status: 'active', inRotation: true, rotationOrder: order, demo: false, createdAt: iso() };
              d.teachers.push(rec); added.push(nm);
            }
          }
          if (used.has(rec.id)) fail(`أكثر من اسم في الملف مرتبط بالمعلم «${rec.name}».`);
          used.add(rec.id);
          if (rec.status !== 'active') { rec.status = 'active'; revived.push(rec.name); audit(d, ctx, 'إعادة تفعيل معلم من الجدول الجاهز', rec.name, dep.id); }
          keyMap.set(key, rec.id);
        }
        if (!keyMap.size) fail(`لا يوجد معلمون في قسم «${dep.name}».`);
        resolved.push({ dep, keyMap, payload: g.payload || {} });
        bump(dep);
      }
      // 2) بنية الأسبوع: الأيام والحصص كما في الملف
      const daySet = new Set(), maxBy = {};
      for (const r of resolved) for (const k of Array.isArray(r.payload.days) ? r.payload.days : []) {
        if (!DAY_KEYS.includes(k)) fail('يوم غير معروف في الجدول المستورد.');
        daySet.add(k);
        const ps = ((r.payload.periodsByDay || {})[k] || []).map(Number);
        if (ps.some(n => !isInt(n, 1, 12))) fail(`رقم حصة غير صالح يوم ${DAY_AR[k]} (المسموح 1–12).`);
        maxBy[k] = Math.max(maxBy[k] || 0, ...ps, 0);
      }
      const days = DAY_KEYS.filter(k => daySet.has(k));
      if (!days.length) fail('لم يُعثر على أيام وحصص في الجدول المستورد.');
      const P = Math.max(...days.map(k => maxBy[k]));
      if (!isInt(P, 1, 12)) fail('عدد الحصص اليومية غير صالح.');
      const dayLen = days.map(k => maxBy[k] || P);
      const slotOf = (day, period) => { const i = days.indexOf(day); if (i < 0 || !isInt(period, 1, dayLen[i])) return -1; return i * P + period - 1; };
      // 3) الإعدادات: المواد = الأقسام (مادة لكل قسم)، والشعب من الملف
      const cfg = prevCfg ? JSON.parse(JSON.stringify(prevCfg)) : { breaks: [], subjects: [], sections: [], noMeeting: [], ruleCatalog: [], rosterRev: 0, idMap: {} };
      cfg.days = days; cfg.periods = P;
      if (dayLen.some(n => n !== P)) cfg.dayPeriods = dayLen; else delete cfg.dayPeriods;
      cfg.breaks = (cfg.breaks || []).filter(b => b < P);
      const subjOf = new Map();
      const counts = new Map(); // لكل قسم: عدد حصص كل شعبة (لاقتراح النصاب عند إضافة مادة جديدة فقط)
      const badCls = new Set(), secSet = new Set();
      const teach = [], meetings = [], commits = [];
      for (const r of resolved) {
        for (const e of Array.isArray(r.payload.entries) ? r.payload.entries : []) {
          const tid = r.keyMap.get(String(e.teacherKey)); if (!tid) continue; // معلم مستبعد في المعاينة
          const slot = slotOf(e.day, Number(e.period));
          if (slot < 0) fail('خانة بيوم أو رقم حصة خارج بنية الجدول.');
          const type = String(e.type || '');
          if (type === 'teach') {
            const sec = secOf(e.cls); if (!sec) { badCls.add(String(e.cls || '').slice(0, 20)); continue; }
            secSet.add(sec); teach.push({ dep: r.dep, tid, slot, sec });
            const c = counts.get(r.dep.id) || new Map(); c.set(sec, (c.get(sec) || 0) + 1); counts.set(r.dep.id, c);
          } else if (type === 'meeting') meetings.push({ dep: r.dep, slot, tid });
          else if (Engine.SLOT_TYPES[type]) commits.push([tid, slot, type, str(e.raw, 120)]);
          else fail('نوع خانة غير معروف في الجدول المستورد.');
        }
      }
      if (badCls.size) fail(`صيغة الشعبة غير مفهومة: ${[...badCls].slice(0, 8).join('، ')}. الصيغة المقبولة: الصف/الرقم أو الصف-الرقم (مثل 8/2).`);
      if (!teach.length) fail('لا توجد حصص تدريس في الجدول المستورد.');
      const secSort = (x, y) => { const [a1, b1] = x.split('-').map(Number), [a2, b2] = y.split('-').map(Number); return a1 - a2 || b1 - b2; };
      cfg.sections = Array.from(new Set((cfg.sections || []).concat([...secSet]))).sort(secSort);
      for (const r of resolved) {
        let s0 = (cfg.subjects || []).find(x => x.deptId === r.dep.id);
        if (!s0) {
          let name = r.dep.name; if ((cfg.subjects || []).some(x => x.name === name)) fail(`توجد مادة باسم «${name}» مرتبطة بقسم آخر في إعدادات الجدول.`);
          const c = [...((counts.get(r.dep.id) || new Map()).values())]; const freq = {}; c.forEach(n => freq[n] = (freq[n] || 0) + 1);
          const load = c.length ? +Object.entries(freq).sort((p, q) => q[1] - p[1] || q[0] - p[0])[0][0] : 0;
          s0 = { name, deptId: r.dep.id, load: Math.min(load, P * days.length), double: false, cap: null, late: false };
          cfg.subjects = (cfg.subjects || []).concat([s0]);
        }
        subjOf.set(r.dep.id, s0.name);
      }
      // 4) الدروس: كل خانة تدريس كما هي؛ الحصتان المتتاليتان لمادة مزدوجة (دون فرصة بينهما وللمعلمين أنفسهم) تُحفظان درسًا مزدوجًا
      const bySlot = new Map();
      for (const x of teach) {
        const subj = subjOf.get(x.dep.id), k = subj + '|' + x.sec + '|' + x.slot;
        if (!bySlot.has(k)) bySlot.set(k, { subj, sec: x.sec, slot: x.slot, t: [] });
        const g = bySlot.get(k); if (!g.t.includes(x.tid)) g.t.push(x.tid);
      }
      const singles = [...bySlot.values()].sort((p, q) => p.subj.localeCompare(q.subj) || secSort(p.sec, q.sec) || p.slot - q.slot);
      const dbl = new Set(cfg.subjects.filter(x => x.double).map(x => x.name)), brk = new Set(cfg.breaks || []);
      const lessons = [], pos = [], taken = new Set();
      for (let i = 0; i < singles.length; i++) {
        const g = singles[i]; if (taken.has(i)) continue;
        const n = singles[i + 1], p = g.slot % P + 1;
        if (dbl.has(g.subj) && n && !taken.has(i + 1) && n.subj === g.subj && n.sec === g.sec && n.slot === g.slot + 1 && Math.floor(n.slot / P) === Math.floor(g.slot / P) && !brk.has(p)
          && g.t.length === n.t.length && g.t.every(t => n.t.includes(t))) { lessons.push({ sec: g.sec, subj: g.subj, t: g.t.slice(), len: 2 }); pos.push(g.slot); taken.add(i + 1); }
        else { lessons.push({ sec: g.sec, subj: g.subj, t: g.t.slice(), len: 1 }); pos.push(g.slot); }
      }
      // 5) الاجتماعات والالتزامات
      const meet = cfg.subjects.map(sj => Array.from(new Set(meetings.filter(m => subjOf.get(m.dep.id) === sj.name).map(m => m.slot))).sort((p, q) => p - q));
      const un = new Map(); for (const [tid, slot] of commits) { if (!un.has(tid)) un.set(tid, new Set()); un.get(tid).add(slot); }
      const unavailIds = [...un.entries()].map(([tid, ss]) => [tid, [...ss].sort((p, q) => p - q)]);
      if (JSON.stringify(lessons).length > 900000) fail('الجدول المستورد أكبر من المسموح.');
      // 6) نسخة احتياطية قبل الاستبدال (للتراجع)، ثم الإعدادات والمسودة
      const vid = uid('ttv');
      const cd = cur && cur.data;
      putRow(d, sid, 'version', vid, {
        name: `نسخة تلقائية قبل استيراد جدول جاهز (${str((a.source || {}).fileName, 80) || 'Excel'})`, auto: true, savedAt: Date.now(), valid: false,
        pos: cd ? cd.pos : [], meet: cd ? cd.meet : [], unavail: cd ? cd.unavail || [] : [], unavailIds: cd ? cd.unavailIds || [] : [],
        ...(cd && Array.isArray(cd.lessons) ? { lessons: cd.lessons, commit: cd.commit || [], meetT: cd.meetT || [], importFile: cd.importFile || null, importAt: cd.importAt || null, importUndo: cd.importUndo || null } : {}),
        noDraft: !cd, prevConfig: prevCfg ? JSON.parse(JSON.stringify(prevCfg)) : null, roster: { rev: (prevCfg && prevCfg.rosterRev) || 0 }
      }, ctx);
      cfg.rosterRev = (cfg.rosterRev || 0) + 1;
      putRow(d, sid, 'config', 'main', cfg, ctx);
      if (!rowOf(d, sid, 'settings')) putRow(d, sid, 'settings', 'main', Object.assign(defaultSettings(cfg, sc), { mode: 'manual' }), ctx);
      const importAt = iso();
      const meetT = meetings.map(m => [m.tid, m.slot]);
      const data = { pos, meet, meetT, unavail: [], unavailIds, lessons, commit: commits, rosterRev: cfg.rosterRev, savedAt: Date.now(), schema: 3, rev: rev + 1, source: 'excel-ready', importFile: str((a.source || {}).fileName, 160) || null, importAt, importUndo: vid };
      putRow(d, sid, 'draft', 'main', data, ctx);
      const vs = rowsOf(d, sid).filter(r => r.kind === 'version').sort((p, q) => p.data.savedAt - q.data.savedAt);
      while (vs.length > MAX_VERSIONS) { const old = vs.shift(); if (old.id === vid) continue; d.timetables.splice(d.timetables.indexOf(old), 1); }
      audit(d, ctx, 'استيراد جدول أسبوعي جاهز من Excel إلى مسودة جدول المدرسة', `${str((a.source || {}).fileName, 120)} — ${resolved.length} قسم، ${lessons.length} درس، ${secSet.size} شعبة${created.length ? `، أقسام جديدة ${created.length}` : ''}${added.length ? `، معلمون جدد ${added.length}` : ''}. جدول الاحتياط لم يتغير (يلزم التفعيل)`, null, { schoolId: sid });
      return { rev: data.rev, versionId: vid, lessons: lessons.length, doubles: lessons.filter(x => x.len === 2).length, sections: secSet.size, depts: resolved.length, created, added, revived, meetings: meet.reduce((n, m) => n + m.length, 0), commitments: commits.length };
    }));
    // التراجع عن آخر استيراد: تُستعاد المسودة والإعدادات كما كانت قبله (سجلات المعلمين والأقسام المضافة تبقى ولا تُحذف)
    op('timetable.importUndo', ['admin', 'school'], async (ctx, a) => tx(d => {
      const { sid } = need(ctx, a, 'ttDraft');
      const cur = rowOf(d, sid, 'draft');
      if (!cur || !cur.data || !cur.data.importUndo) fail('لا يوجد استيراد يمكن التراجع عنه.');
      if (a.baseRev != null && a.baseRev !== (cur.data.rev || 0)) fail('تغيّرت المسودة. حدّث الصفحة ثم أعد المحاولة.', 'conflict');
      const v = rowOf(d, sid, 'version', cur.data.importUndo);
      if (!v || !v.data || !('prevConfig' in v.data)) fail('النسخة الاحتياطية لهذا الاستيراد غير موجودة.');
      const b = v.data;
      if (b.prevConfig) putRow(d, sid, 'config', 'main', Object.assign(JSON.parse(JSON.stringify(b.prevConfig)), { rosterRev: (cfgOf(d, sid).rosterRev || 0) + 1, idMap: cfgOf(d, sid).idMap || {} }), ctx);
      else d.timetables.splice(d.timetables.indexOf(rowOf(d, sid, 'config')), 1);
      const rev = (cur.data.rev || 0) + 1;
      if (b.noDraft) d.timetables.splice(d.timetables.indexOf(cur), 1);
      else putRow(d, sid, 'draft', 'main', {
        pos: b.pos, meet: b.meet, unavail: b.unavail || [], unavailIds: b.unavailIds || [], rosterRev: (cfgOf(d, sid) || {}).rosterRev || 0, savedAt: Date.now(), schema: Array.isArray(b.lessons) ? 3 : 2, rev, source: 'restore',
        ...(Array.isArray(b.lessons) ? { lessons: b.lessons, commit: b.commit || [], meetT: b.meetT || [], importFile: b.importFile || null, importAt: b.importAt || null, importUndo: b.importUndo || null } : {})
      }, ctx);
      audit(d, ctx, 'التراجع عن استيراد جدول جاهز', 'استُعيدت المسودة والإعدادات كما كانت قبل الاستيراد؛ جدول الاحتياط لم يتغير', null, { schoolId: sid });
      return { rev };
    }));

    /* حالة «جدول المدرسة» لقسم واحد (لمصدر «الإدارة» في صفحة جدول القسم): ما الموجود وما الناقص تحديدًا، دون أي تعديل.
       - لا جدول / إعداد فقط / مسودة لم تُعتمد وتُفعَّل للاحتياط / مفعّل (ويشمل القسم أو لا).
       - لمن يملك «اعتماد الجدول»: فحص ما قبل التفعيل (ما يمنعه الآن) ووضع الجدولة. */
    op('timetable.deptStatus', ['admin', 'head'], async (ctx, a) => {
      const d = getDb();
      const dep = deptIn(d, X.scope(ctx, a.deptId));
      const sid = dep.schoolId || null; const sc = sid ? schoolIn(d, sid) : null;
      if (!sc) return { state: 'noschool', deptName: dep.name };
      const cfg = cfgOf(d, sid), dRow = rowOf(d, sid, 'draft'), sRow = rowOf(d, sid, 'settings');
      const mode = modeOf(sRow && sRow.data);
      const canApprove = permsOf(ctx, sid).has('ttApprove');
      const subjects = cfg ? (cfg.subjects || []).filter(x => x.deptId === dep.id).map(x => x.name) : [];
      const draft = dRow && dRow.data ? dRow.data : null;
      let deptLessons = null, deptTeachers = null;
      if (draft && Array.isArray(draft.lessons)) {
        const ls = draft.lessons.filter(L => subjects.includes(L.subj));
        deptLessons = ls.length; deptTeachers = new Set(ls.flatMap(L => (L.t || []).map(id => mapId(cfg, String(id))))).size;
      }
      const acts = rowsOf(d, sid).filter(r => r.kind === 'activation').sort((p, q) => (p.at < q.at ? 1 : -1));
      const last = acts[0] || null;
      const out = {
        school: { id: sc.id, name: sc.name }, deptName: dep.name, mode, canApprove, subjects,
        state: !cfg ? 'none' : !draft || !Array.isArray(draft.pos) ? 'setup' : !acts.length ? 'draft' : 'activated',
        draft: draft ? { rev: draft.rev || 0, file: draft.importFile || null, importedAt: draft.importAt || null, savedAt: draft.savedAt ? new Date(draft.savedAt).toISOString() : (dRow.at || null), deptLessons, deptTeachers } : null,
        activation: last ? { at: last.at, by: last.by, effectiveFrom: last.data.effectiveFrom, includesDept: (last.data.depts || []).some(x => x.deptId === dep.id), draftRev: last.data.draftRev, stale: !!(draft && (draft.rev || 0) !== last.data.draftRev) } : null,
        preflight: null
      };
      // ما يمنع التفعيل الآن (للمخوّل فقط)
      if (canApprove && cfg && draft && Array.isArray(draft.pos)) {
        try { const ev = evaluate(d, sid); out.preflight = { errors: ev.errors.length, hard: ev.hard.length, soft: ev.soft.length, sample: (ev.hard.length ? ev.hard : ev.soft.map(x => x.msg)).slice(0, 3), notes: (ev.notes || []).length, mode: ev.mode }; }
        catch (e) { out.preflight = { errors: 1, sample: ['تعذّر فحص المسودة: ' + String(e && e.message || e).slice(0, 200)], notes: 0, mode }; }
      }
      return out;
    });
    return { permsOf, TT_PERMS };
  }

  const TTOps = { install, TT_PERMS, approvedRules, DAY_AR };
  if (typeof module !== 'undefined' && module.exports) module.exports = TTOps;
  root.TTOps = TTOps;
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* «جدولي» و«جدول القسم» وطلبات تبديل الحصص المؤقتة — عمليات الخادم.
 * التبديل تعديل مؤقت مرتبط بتاريخ وحصص محددة: لا يمس إصدارات الجدول الأساسي (جدول المدرسة أو الجدول الداخلي)
 * ولا يتكرر في أسبوع آخر. الجدول الفعلي لتاريخ = الجدول الأساسي الساري + التبديلات المعتمدة في ذلك التاريخ،
 * ويستخدمه عرض الجداول ومحرك الاحتياط (التوفر واستخراج حصص الغياب).
 * القرار: أول قرار نهائي صحيح (موافقة المعلم الآخر أو موافقة/رفض الإدارة المخوّلة) يغلق الطلب مرة واحدة،
 * داخل معاملة واحدة مقفلة، فلا يُطبَّق طلب مرتين. لا ذكاء اصطناعي أثناء التشغيل.
 */
(function (root) {
  'use strict';
  const KINDS = { swap: 'تبادل حصتين', cover: 'تغطية حصة' };
  const STATUS = { pending: 'بانتظار القرار', approved: 'معتمد', rejected: 'مرفوض', withdrawn: 'مسحوب', cancelled: 'أُلغي بعد الاعتماد', expired: 'انتهى دون قرار' };
  const TYPE_AR = { teach: 'تدريس', meeting: 'اجتماع', task: 'مهمة', work: 'عمل', fixed: 'التزام ثابت' };
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

  function install(X) {
    const { op, tx, fail, audit, iso, uid, deptIn, schoolIn, deptsOfSchool, teachersOf, Engine, kuwaitToday, now, schedAt, liveGrants } = X;
    const getDb = X.db;
    const list = d => (Array.isArray(d.swaps) ? d.swaps : []);
    const aaList = d => (Array.isArray(d.adminAssigns) ? d.adminAssigns : []);
    const tOf = (d, id) => d.teachers.find(t => t.id === id) || null;
    const nameOf = (d, id) => (tOf(d, id) || {}).name || '—';
    const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
    const addDays = (ds, n) => { const x = new Date(ds + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
    const dow = ds => new Date(ds + 'T12:00:00Z').getUTCDay(); // 0 = الأحد
    const kwTime = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuwait', hour: '2-digit', minute: '2-digit', hour12: false }).format(now()).replace(/^24:/, '00:');
    const clsOf = e => (e && e.cls != null ? String(e.cls).trim() : '');

    // ---------- الربط بسجل المعلم ----------
    /* حساب المعلم ونائب رئيس القسم: سجل المعلم المحفوظ في الحساب. حساب رئيس القسم: سجله إن رُبط، وإلا رئيس القسم
       المحدد في القسم بشرط أن يكون الحساب الوحيد الفعّال من نوع «رئيس قسم» فيه. غير ذلك: غير مرتبط (لا تخمين). */
    function linkedTeacherOfAcc(d, a) {
      if (!a || a.status !== 'active') return null;
      if (a.kind === 'principal' || a.kind === 'assistant') return null;
      let tid = a.teacherId || null;
      if (!tid && (a.kind === 'head' || !a.kind)) {
        const dep = deptIn(d, a.deptId);
        const heads = d.accounts.filter(x => x.deptId === a.deptId && (x.kind === 'head' || !x.kind) && x.status === 'active');
        if (dep && dep.headTeacherId && heads.length === 1 && heads[0].id === a.id) tid = dep.headTeacherId;
      }
      const t = tid ? tOf(d, tid) : null;
      if (!t || t.status !== 'active') return null;
      if (a.kind === 'teacher' || a.kind === 'deputy') { if (t.deptId !== a.deptId && a.kind === 'deputy') return null; }
      return t;
    }
    const linkedOf = (d, ctx) => (ctx && (ctx.role === 'teacher' || ctx.role === 'head') ? linkedTeacherOfAcc(d, d.accounts.find(x => x.id === ctx.id)) : null);
    const accountsOfTeacher = (d, tid) => d.accounts.filter(a => { const t = linkedTeacherOfAcc(d, a); return t && t.id === tid; }).map(a => a.id);

    // ---------- الجدول الفعلي حسب التاريخ ----------
    const sideOk = (base, dayKey, tid, period, cls) => !!base && (base.entries || []).some(e => e.day === dayKey && e.teacherId === tid && e.period === period && e.type === 'teach' && clsOf(e) === cls);
    /* يطبّق التبديلات المعتمدة لتاريخ على جدول قسم أساسي (نسخة جديدة؛ الأساسي لا يتغير). except: معرّف تبديل يُستثنى.
       الجانب الذي لم تعد حصته الأساسية موجودة في الجدول الأساسي (بعد تعديل دائم) لا يُطبَّق ويُعرض للمراجعة. */
    function applySwaps(d, dep, date, base, except) {
      if (!base || !dep || !date) return base;
      const dayKey = Engine.dayKeyOf(date);
      const mine = list(d).filter(s => s.status === 'approved' && s.date === date && s.id !== except && (s.a.deptId === dep.id || s.b.deptId === dep.id));
      if (!mine.length) return base;
      const out = { ...base, entries: base.entries.slice(), swapsApplied: [] };
      const drop = (tid, p) => { out.entries = out.entries.filter(e => !(e.day === dayKey && e.teacherId === tid && e.period === p && e.type === 'teach')); };
      const add = (tid, p, cls, s, role) => out.entries.push({ teacherId: tid, day: dayKey, period: p, type: 'teach', cls, raw: cls, swapId: s.id, swapRole: role });
      for (const s of mine) {
        const applied = [];
        if (s.a.deptId === dep.id && sideOk(base, dayKey, s.a.teacherId, s.a.period, s.a.cls)) {
          drop(s.a.teacherId, s.a.period);
          if (s.kind === 'swap') add(s.a.teacherId, s.b.period, s.b.cls, s, 'in');
          applied.push('a');
        }
        if (s.b.deptId === dep.id) {
          if (s.kind === 'swap') { if (sideOk(base, dayKey, s.b.teacherId, s.b.period, s.b.cls)) { drop(s.b.teacherId, s.b.period); add(s.b.teacherId, s.a.period, s.a.cls, s, 'in'); applied.push('b'); } }
          else { add(s.b.teacherId, s.a.period, s.a.cls, s, 'cover'); applied.push('b'); }
        }
        out.swapsApplied.push({ id: s.id, applied });
      }
      return out;
    }
    const effAt = (d, dep, date, except) => applySwaps(d, dep, date, schedAt(dep, date), except);

    // ---------- الفحص ----------
    const dayRec = (d, deptId, date) => d.days.find(x => x.deptId === deptId && x.date === date) || null;
    // ما يشغل المعلم في حصة بتاريخ: حصة/التزام في جدوله الفعلي، أو احتياط مسند إليه (من القسم أو الإدارة)
    function busyReason(d, t, date, period, opt) {
      opt = opt || {};
      const dep = deptIn(d, t.deptId); const dayKey = Engine.dayKeyOf(date);
      const sch = effAt(d, dep, date, opt.except);
      const e = sch ? sch.entries.find(x => x.day === dayKey && x.teacherId === t.id && x.period === period && !(!x.swapId && (opt.ignore || []).includes(x.teacherId + '|' + x.period))) : null;
      if (e) return e.type === 'teach' ? `«${t.name}» لديه حصة تدريس في الحصة ${period} (الصف ${clsOf(e) || '—'})${e.swapId ? ' بتبديل معتمد آخر' : ''}.` : `«${t.name}» لديه ${TYPE_AR[e.type] || 'التزام'} في الحصة ${period}.`;
      for (const rec of d.days) if (rec.date === date) for (const sl of (rec.result && rec.result.slots) || []) if (sl.status === 'covered' && sl.teacherId === t.id && sl.period === period) return `«${t.name}» مكلّف بحصة احتياط في الحصة ${period} (الصف ${sl.cls || '—'}).`;
      for (const x of aaList(d)) if (x.state === 'assigned' && x.teacherId === t.id && x.date === date && x.period === period) return `«${t.name}» مكلّف من الإدارة بحصة احتياط في الحصة ${period} (الصف ${x.cls || '—'}).`;
      return null;
    }
    // غياب معتمد للمعلم في التاريخ: التبديل يغيّر حصص غيابه في توزيع معتمد؛ لا يُطبَّق بصمت
    function absentReason(d, t, date) {
      const rec = dayRec(d, t.deptId, date);
      if (rec && (rec.absentIds || []).includes(t.id)) return `«${t.name}» مسجّل غائبًا في توزيع احتياط معتمد لقسمه (${(deptIn(d, t.deptId) || {}).name || ''}) بتاريخ ${date}. التبديل يغيّر حصص غيابه، فلا يُطبَّق دون تصحيح ذلك اليوم: يصحّح المسؤول غياب اليوم المعتمد من «احتياط اليوم» ← «تعديل غياب يوم معتمد» أولًا، ثم يُعاد الطلب.`;
      return null;
    }
    const periodTimesOf = sc => (sc && sc.periodTimes && typeof sc.periodTimes === 'object' ? sc.periodTimes : {});
    // التاريخ والحصة لم يمضيا: الأيام السابقة مرفوضة، واليوم يحتاج وقت بداية الحصة المسجل (لا تخمين)
    function timeReason(d, sc, date, periods) {
      const today = kuwaitToday(now());
      if (date < today) return 'التاريخ مضى؛ لا يمكن طلب تبديل أو اعتماده أو إلغاؤه لتاريخ سابق.';
      if (date > today) return null;
      const pt = periodTimesOf(sc); const nowT = kwTime();
      for (const p of periods) {
        // توقيت اليوم الدراسي المعتمد أولًا (فترة الحصة بالرقم نفسه)، ثم أوقات البداية المسجلة سابقًا
        const t = (X.lessonStart && X.lessonStart(sc, date, p)) || pt[String(p)];
        if (!t || !HHMM.test(t)) return `لا يوجد وقت بداية مسجل للحصة ${p} في توقيت اليوم الدراسي لهذا اليوم، فلا يمكن التحقق من أن الحصة لم تبدأ. تضبطه إدارة المدرسة من «الإعدادات» ← «توقيت اليوم الدراسي». يمكن الطلب لتاريخ لاحق خلال الأسبوع.`;
        if (nowT >= t) return `الحصة ${p} بدأت أو مضت اليوم (تبدأ ${t}، والوقت الآن ${nowT}).`;
      }
      return null;
    }
    // نافذة الطلب: اليوم حتى نهاية الأسبوع الدراسي الحالي (أول خميس من اليوم فصاعدًا)
    function windowOf() {
      const today = kuwaitToday(now()); let to = today;
      while (dow(to) !== 4) to = addDays(to, 1);
      return { from: today, to };
    }

    /* فحص طلب كامل (عند المعاينة والإرسال والموافقة). يعيد { ok, errors, before, after, req } */
    function evaluate(d, sid, q, opt) {
      opt = opt || {};
      const errors = [];
      const sc = schoolIn(d, sid);
      const date = String(q.date || '');
      if (!isDate(date)) return { ok: false, errors: ['حدّد التاريخ.'] };
      const kind = q.kind === 'cover' ? 'cover' : q.kind === 'swap' ? 'swap' : null;
      if (!kind) return { ok: false, errors: ['اختر نوع الطلب: تبادل حصتين أو تغطية حصة.'] };
      const A = tOf(d, q.teacherId), B = tOf(d, q.partnerId);
      if (!A || A.status !== 'active') return { ok: false, errors: ['المعلم مقدّم الطلب غير موجود أو غير فعّال.'] };
      if (!B || B.status !== 'active') return { ok: false, errors: ['اختر المعلم الآخر من معلمي المدرسة الفعّالين.'] };
      if (A.id === B.id) return { ok: false, errors: ['اختر معلمًا آخر غيرك.'] };
      const dA = deptIn(d, A.deptId), dB = deptIn(d, B.deptId);
      if (!dA || dA.schoolId !== sid || !dB || dB.schoolId !== sid) return { ok: false, errors: ['المعلم الآخر ليس من المدرسة نفسها.'] };
      if (dA.status === 'inactive' || dB.status === 'inactive') errors.push('أحد القسمين غير فعّال.');
      if (!opt.decision) {
        const w = windowOf();
        if (date < w.from) errors.push('التاريخ مضى؛ لا يمكن طلب تبديل لتاريخ سابق.');
        else if (date > w.to) errors.push(`التاريخ خارج الأسبوع الدراسي الحالي (من ${w.from} إلى ${w.to}). التبديل واقعة بتاريخ محدد وليس تغييرًا أسبوعيًا.`);
      }
      const dayKey = Engine.dayKeyOf(date);
      const pa = Number(q.period), pb = kind === 'swap' ? Number(q.partnerPeriod) : null;
      const baseA = schedAt(dA, date), baseB = schedAt(dB, date);
      if (!baseA) errors.push(`لا يوجد جدول أساسي ساري لقسم «${dA.name}» في ${date}.`);
      if (!baseB) errors.push(`لا يوجد جدول أساسي ساري لقسم «${dB.name}» في ${date}.`);
      if (errors.length) return { ok: false, errors };
      if (!baseA.days.includes(dayKey)) errors.push(`يوم ${Engine.DAY_NAMES[dayKey]} ليس يومًا دراسيًا في جدول قسم «${dA.name}».`);
      if (!baseB.days.includes(dayKey)) errors.push(`يوم ${Engine.DAY_NAMES[dayKey]} ليس يومًا دراسيًا في جدول قسم «${dB.name}».`);
      if (errors.length) return { ok: false, errors };
      const eA = baseA.entries.find(e => e.day === dayKey && e.teacherId === A.id && e.period === pa && e.type === 'teach');
      if (!eA) return { ok: false, errors: [`لا توجد حصة تدريس أساسية لـ«${A.name}» في الحصة ${pa} يوم ${Engine.DAY_NAMES[dayKey]} ${date}.`] };
      const ca = clsOf(eA);
      if (!ca) errors.push(`الحصة ${pa} لـ«${A.name}» مسجلة دون صف؛ لا يمكن تبديلها.`);
      if (q.cls != null && String(q.cls) !== ca) errors.push('تغيّرت الحصة الأصلية في الجدول منذ فتح الصفحة. أعد اختيارها.');
      let eB = null, cb = null;
      if (kind === 'swap') {
        eB = baseB.entries.find(e => e.day === dayKey && e.teacherId === B.id && e.period === pb && e.type === 'teach');
        if (!eB) return { ok: false, errors: [`لا توجد حصة تدريس أساسية لـ«${B.name}» في الحصة ${pb} يوم ${Engine.DAY_NAMES[dayKey]} ${date}.`] };
        cb = clsOf(eB);
        if (!cb) errors.push(`الحصة ${pb} لـ«${B.name}» مسجلة دون صف؛ لا يمكن تبديلها.`);
        if (q.partnerCls != null && String(q.partnerCls) !== cb) errors.push('تغيّرت الحصة المقابلة في الجدول منذ فتح الصفحة. أعد اختيارها.');
        if (pa === pb && ca === cb) errors.push('الحصتان متطابقتان؛ لا يوجد ما يُبدَّل.');
        if (!(baseA.periodsByDay[dayKey] || []).includes(pb)) errors.push(`الحصة ${pb} ليست من حصص يوم ${Engine.DAY_NAMES[dayKey]} في جدول قسم «${dA.name}».`);
      }
      if (!(baseB.periodsByDay[dayKey] || []).includes(pa)) errors.push(`الحصة ${pa} ليست من حصص يوم ${Engine.DAY_NAMES[dayKey]} في جدول قسم «${dB.name}».`);
      // لا طلب معتمد آخر على الواقعة نفسها (الحصتان أو الخانتان الهدف)، ولا طلب معلّق مكرر على الحصة نفسها
      const pairsOf = x => (x.kind === 'swap' ? [x.a.teacherId + '|' + x.a.period, x.b.teacherId + '|' + x.b.period, x.a.teacherId + '|' + x.b.period, x.b.teacherId + '|' + x.a.period] : [x.a.teacherId + '|' + x.a.period, x.b.teacherId + '|' + x.a.period]);
      const mineP = new Set(pairsOf({ kind, a: { teacherId: A.id, period: pa }, b: { teacherId: B.id, period: pb } }));
      for (const s of list(d)) {
        if (s.id === opt.except || s.date !== date) continue;
        if (s.status === 'approved' && pairsOf(s).some(k => mineP.has(k)))
          errors.push(`يوجد تبديل معتمد آخر على إحدى الحصتين في ${date} (${KINDS[s.kind]}: ${s.a.name} ↔ ${s.b.name}). لا يُعتمد طلبان على الواقعة نفسها.`);
        if (!opt.decision && s.status === 'pending' && s.a.teacherId === A.id && s.a.period === pa)
          errors.push(`لديك طلب معلّق على الحصة نفسها (${pa}) في ${date}. انتظر قراره أو اسحبه أولًا.`);
      }
      // الوقت
      const tr = timeReason(d, sc, date, kind === 'swap' ? [pa, pb] : [pa]); if (tr) errors.push(tr);
      // الغياب في توزيع معتمد
      for (const t of [A, B]) { const r = absentReason(d, t, date); if (r) errors.push(r); }
      // التوفر في النتيجة النهائية: بعد رفع الحصتين المتبادلتين من موضعيهما
      if (kind === 'swap') {
        const ign = [A.id + '|' + pa, B.id + '|' + pb];
        const ra = pa === pb ? null : busyReason(d, A, date, pb, { ignore: ign, except: opt.except });
        const rb = pa === pb ? null : busyReason(d, B, date, pa, { ignore: ign, except: opt.except });
        if (ra) errors.push('لا يمكن أن يأخذ مقدّم الطلب الحصة المقابلة: ' + ra);
        if (rb) errors.push('لا يمكن أن يأخذ المعلم الآخر الحصة الأصلية: ' + rb);
      } else {
        const rb = busyReason(d, B, date, pa, { except: opt.except });
        if (rb) errors.push('المعلم الآخر غير متاح لتغطية الحصة: ' + rb);
      }
      const L = (t, dep, p, cls) => ({ teacherId: t.id, name: t.name, deptId: dep.id, deptName: dep.name, period: p, cls });
      const req = { date, dayKey, kind, a: L(A, dA, pa, ca), b: kind === 'swap' ? L(B, dB, pb, cb) : { ...L(B, dB, null, null) }, baseVersions: { a: baseA.version, b: baseB.version } };
      const before = { a: [{ period: pa, cls: ca }].concat(kind === 'swap' && pa !== pb ? [{ period: pb, free: true }] : []), b: kind === 'swap' ? [{ period: pb, cls: cb }].concat(pa !== pb ? [{ period: pa, free: true }] : []) : [{ period: pa, free: true }] };
      const after = kind === 'swap'
        ? { a: [{ period: pb, cls: cb }].concat(pa !== pb ? [{ period: pa, free: true }] : []), b: [{ period: pa, cls: ca }].concat(pa !== pb ? [{ period: pb, free: true }] : []) }
        : { a: [{ period: pa, free: true }], b: [{ period: pa, cls: ca }] };
      return { ok: !errors.length, errors: Array.from(new Set(errors)), req, before, after };
    }

    // ---------- الصلاحيات والمستلمون ----------
    // الإدارة المخوّلة بقرار الطلبات: مدير النظام، مدير المدرسة ومساعدوه، أو مفوَّض بصلاحية «إدارة طلبات تبديل الحصص» للمدرسة
    function adminGrant(ctx, sid) {
      if (!ctx) return null;
      if (ctx.role === 'admin') return { as: 'admin' };
      if (ctx.role === 'school') return ctx.schoolId === sid ? { as: 'admin' } : null;
      if (ctx.role === 'head') { const g = (ctx.grants || []).find(x => x.schoolId === sid && x.perms.has('swapManage')); return g ? { as: 'admin', grant: g } : null; }
      return null;
    }
    function adminRecipients(d, sid) {
      const out = [];
      for (const a of d.accounts) {
        if (a.status !== 'active') continue;
        if ((a.kind === 'principal' || a.kind === 'assistant') && a.schoolId === sid) out.push(a.id);
        else if (a.kind !== 'teacher' && liveGrants(d, a.id).some(g => g.schoolId === sid && g.perms.has('swapManage'))) out.push(a.id);
      }
      return out;
    }
    function pushEvent(d, s, kind, ctx, extraTo) {
      const sid = s.schoolId;
      const to = new Set(accountsOfTeacher(d, s.a.teacherId).concat(accountsOfTeacher(d, s.b.teacherId), adminRecipients(d, sid), extraTo || []));
      if (ctx && ctx.id) to.delete(ctx.id);
      s.events = (s.events || []).concat([{ id: uid('sev'), kind, at: iso(), actor: ctx ? ctx.name : 'النظام', to: Array.from(to) }]);
    }
    const schoolOfCtx = (d, ctx, sidArg) => {
      if (ctx.role === 'admin') { const sc = schoolIn(d, sidArg); if (!sc) fail('المدرسة غير موجودة.', 'not_found'); return sc.id; }
      if (ctx.role === 'school') { if (sidArg && sidArg !== ctx.schoolId) fail('غير مصرح لك بالوصول إلى هذه المدرسة.', 'forbidden'); return ctx.schoolId; }
      if (ctx.role === 'head') {
        const own = deptIn(d, ctx.deptId); const ownSid = own ? own.schoolId : null;
        if (sidArg && sidArg !== ownSid && !(ctx.grants || []).some(g => g.schoolId === sidArg)) fail('غير مصرح لك بالوصول إلى هذه المدرسة.', 'forbidden');
        return sidArg || ownSid;
      }
      const dep = deptIn(d, ctx.deptId); return dep ? dep.schoolId : null;
    };
    const statusOf = s => (s.status === 'pending' && s.date < kuwaitToday(now()) ? 'expired' : s.status);
    // التبديل المعتمد المستقبلي الذي لم تعد حصصه في الجدول الأساسي (بعد تعديل دائم): يُعرض للمراجعة ولا يُحذف ولا يُنقل
    function reviewOf(d, s) {
      if (!['approved', 'pending'].includes(s.status) || s.date < kuwaitToday(now())) return null;
      const dk = Engine.dayKeyOf(s.date); const out = [];
      const dA = deptIn(d, s.a.deptId), dB = deptIn(d, s.b.deptId);
      const bA = dA ? schedAt(dA, s.date) : null, bB = dB ? schedAt(dB, s.date) : null;
      // قسم لم تُحمَّل خاناته (تحميل خفيف) لا يُحكم عليه
      const known = b => b && Array.isArray(b.entries) && b.entries.length > 0;
      if (known(bA) && !sideOk(bA, dk, s.a.teacherId, s.a.period, s.a.cls)) out.push(`حصة «${s.a.name}» (الحصة ${s.a.period} — ${s.a.cls}) لم تعد في الجدول الأساسي الساري (الإصدار ${bA.version}).`);
      if (s.kind === 'swap' && known(bB) && !sideOk(bB, dk, s.b.teacherId, s.b.period, s.b.cls)) out.push(`حصة «${s.b.name}» (الحصة ${s.b.period} — ${s.b.cls}) لم تعد في الجدول الأساسي الساري (الإصدار ${bB.version}).`);
      return out.length ? out : null;
    }
    function view(d, s, ctx) {
      const st = statusOf(s); const me = linkedOf(d, ctx);
      const isReq = !!me && me.id === s.a.teacherId, isPartner = !!me && me.id === s.b.teacherId;
      const adm = adminGrant(ctx, s.schoolId);
      const open = st === 'pending';
      return {
        id: s.id, date: s.date, dayName: Engine.DAY_NAMES[Engine.dayKeyOf(s.date)], kind: s.kind, kindName: KINDS[s.kind], status: st, statusName: STATUS[st],
        a: { name: s.a.name, deptName: s.a.deptName, period: s.a.period, cls: s.a.cls }, b: { name: s.b.name, deptName: s.b.deptName, period: s.b.period, cls: s.b.cls },
        note: s.note || '', createdAt: s.createdAt, createdBy: s.createdBy ? s.createdBy.name : '',
        decision: s.decision ? { action: s.decision.action, as: s.decision.as, by: s.decision.name, role: s.decision.roleName, at: s.decision.at, reason: s.decision.reason || '' } : null,
        withdrawn: s.withdrawn ? { at: s.withdrawn.at, by: s.withdrawn.name } : null,
        cancel: s.cancel ? { at: s.cancel.at, by: s.cancel.name, role: s.cancel.roleName, reason: s.cancel.reason || '' } : null,
        mine: isReq ? 'requester' : isPartner ? 'partner' : null,
        can: { decidePartner: open && isPartner, decideAdmin: open && !!adm, withdraw: open && isReq, cancel: st === 'approved' && !!adm && s.date >= kuwaitToday(now()) },
        review: reviewOf(d, s)
      };
    }
    const ROLE_NAME = ctx => (ctx.role === 'admin' ? 'مدير النظام' : ctx.role === 'school' ? (ctx.kind === 'assistant' ? 'مساعد المدير' : 'مدير المدرسة') : ctx.role === 'teacher' ? 'معلم' : ctx.kind === 'deputy' ? 'نائب رئيس القسم' : 'رئيس القسم');
    const describe = s => s.kind === 'swap'
      ? `${s.date}: ${s.a.name} (الحصة ${s.a.period} — ${s.a.cls}) ↔ ${s.b.name} (الحصة ${s.b.period} — ${s.b.cls})`
      : `${s.date}: تغطية حصة ${s.a.name} (الحصة ${s.a.period} — ${s.a.cls}) بواسطة ${s.b.name}`;
    const auditDept = (ctx, s) => (ctx.role === 'head' || ctx.role === 'teacher' ? ctx.deptId : s.a.deptId);

    // ---------- العمليات ----------
    function needLinked(d, ctx) {
      const t = linkedOf(d, ctx);
      if (!t) fail('هذا الحساب غير مرتبط بسجل معلم، فلا يوجد جدول شخصي له. يربطه مدير النظام بسجل المعلم الصحيح عند الحاجة.', 'not_linked');
      const dep = deptIn(d, t.deptId);
      if (!dep || !dep.schoolId) fail('قسم المعلم غير مرتبط بمدرسة؛ طلبات التبديل تعمل داخل المدرسة الواحدة.', 'not_ready');
      return { t, dep };
    }
    function weekOf(date) {
      let start = date; while (dow(start) !== 0) start = addDays(start, -1);
      return { start, dates: [0, 1, 2, 3, 4, 5, 6].map(i => addDays(start, i)) };
    }
    const reserveOf = (d, tid, date) => {
      const out = [];
      for (const rec of d.days) if (rec.date === date) for (const sl of (rec.result && rec.result.slots) || []) if (sl && sl.teacherId === tid && sl.status === 'covered')
        out.push({ period: sl.period, cls: sl.cls == null ? '' : String(sl.cls), from: 'dept', fromName: 'القسم', absentName: sl.absentName || '' });
      for (const e of aaList(d)) if (e.state === 'assigned' && e.teacherId === tid && e.date === date)
        out.push({ period: e.period, cls: e.cls == null ? '' : String(e.cls), from: 'admin', fromName: 'الإدارة', srcDeptName: e.srcDeptName || '' });
      return out.sort((x, y) => x.period - y.period);
    };
    // يوم واحد لمعلم: حصصه الفعلية مع علامات التبديل، والاحتياط المسند إليه في ذلك التاريخ فقط
    function teacherDay(d, t, dep, date) {
      const dk = Engine.dayKeyOf(date); const base = schedAt(dep, date);
      if (!base || !base.days.includes(dk)) return { date, dayKey: dk, study: false, items: [], periods: [] };
      const eff = applySwaps(d, dep, date, base);
      const swapById = new Map(list(d).filter(s => s.date === date).map(s => [s.id, s]));
      const items = eff.entries.filter(e => e.day === dk && e.teacherId === t.id).map(e => {
        const s = e.swapId ? swapById.get(e.swapId) : null;
        return { period: e.period, type: e.type, typeName: TYPE_AR[e.type] || 'التزام', cls: clsOf(e), swap: s ? { id: s.id, kind: s.kind, kindName: KINDS[s.kind], role: e.swapRole, with: s.a.teacherId === t.id ? s.b.name : s.a.name, before: e.swapRole === 'cover' ? null : (s.a.teacherId === t.id ? { period: s.a.period, cls: s.a.cls } : { period: s.b.period, cls: s.b.cls }) } : null };
      });
      // حصص أساسية رُفعت بتبديل معتمد (للعرض «قبل/بعد»)
      const freed = [];
      for (const x of eff.swapsApplied || []) {
        const s = swapById.get(x.id); if (!s) continue;
        if (s.a.teacherId === t.id && x.applied.includes('a')) freed.push({ period: s.a.period, cls: s.a.cls, swap: { id: s.id, kind: s.kind, kindName: KINDS[s.kind], with: s.b.name, after: s.kind === 'swap' ? { period: s.b.period, cls: s.b.cls } : null } });
        if (s.kind === 'swap' && s.b.teacherId === t.id && x.applied.includes('b')) freed.push({ period: s.b.period, cls: s.b.cls, swap: { id: s.id, kind: s.kind, kindName: KINDS[s.kind], with: s.a.name, after: { period: s.a.period, cls: s.a.cls } } });
      }
      const rec = dayRec(d, dep.id, date);
      const sc = dep.schoolId ? schoolIn(d, dep.schoolId) : null;
      return { bell: X.bellDay ? X.bellDay(sc, date, t.id) : null, date, dayKey: dk, study: true, periods: (base.periodsByDay[dk] || []).slice(), items: items.sort((x, y) => x.period - y.period), freed, reserve: reserveOf(d, t.id, date),
        absent: !!(rec && (rec.absentIds || []).includes(t.id)), version: base.version };
    }

    op('my.schedule', ['head', 'teacher'], async (ctx, a) => {
      const d = getDb();
      const t = linkedOf(d, ctx);
      if (!t) return { linked: false, reason: 'هذا الحساب غير مرتبط بسجل معلم، فلا يوجد جدول شخصي له. يربطه مدير النظام بسجل المعلم الصحيح عند الحاجة.' };
      const dep = deptIn(d, t.deptId); const sc = dep.schoolId ? schoolIn(d, dep.schoolId) : null;
      const today = kuwaitToday(now());
      let ref = isDate(a.date) ? a.date : today;
      if (!isDate(a.date) && (dow(ref) === 5 || dow(ref) === 6)) while (dow(ref) !== 0) ref = addDays(ref, 1);
      const wk = weekOf(ref);
      const cur = schedAt(dep, today);
      const weekly = cur ? { version: cur.version, effectiveFrom: cur.effectiveFrom || null, days: cur.days.slice(), periodsByDay: structuredClone(cur.periodsByDay),
        entries: cur.entries.filter(e => e.teacherId === t.id).map(e => ({ day: e.day, period: e.period, type: e.type, cls: clsOf(e) })) } : null;
      const days = wk.dates.map(dt => teacherDay(d, t, dep, dt)).filter(x => x.study);
      const swaps = list(d).filter(s => s.a.teacherId === t.id || s.b.teacherId === t.id).sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1)).slice(0, 80).map(s => view(d, s, ctx));
      return { linked: true, today, teacher: { id: t.id, name: t.name }, deptName: dep.name, schoolName: sc ? sc.name : '', schoolId: sc ? sc.id : null,
        week: { start: wk.start, prev: addDays(wk.start, -7), next: addDays(wk.start, 7) }, weekly, days, swaps, window: windowOf(), timesSet: Object.keys(periodTimesOf(sc)).length > 0 || !!(sc && sc.bell && Array.isArray(sc.bell.versions) && sc.bell.versions.length) };
    });

    // جدول القسم للقراءة فقط: الأسماء والحصص والصفوف فقط (لا حسابات ولا أرقام مدنية ولا ملاحظات)
    op('my.deptSchedule', ['head', 'teacher'], async (ctx, a) => {
      const d = getDb();
      let dep;
      if (ctx.role === 'teacher') dep = deptIn(d, ctx.deptId);
      else { const t = linkedOf(d, ctx); dep = deptIn(d, t ? t.deptId : ctx.deptId); }
      if (!dep) fail('القسم غير موجود.', 'not_found');
      const me0 = linkedOf(d, ctx);
      if (ctx.role === 'teacher' && me0 && me0.trainee) fail('جدول القسم غير متاح لحسابك (معلم متدرب). يظهر لك جدولك فقط من «جدولي».', 'forbidden');
      const today = kuwaitToday(now());
      const date = isDate(a.date) ? a.date : today;
      const base = schedAt(dep, date);
      if (!base) return { deptName: dep.name, date, today, schedule: null };
      const dk = Engine.dayKeyOf(date);
      const eff = applySwaps(d, dep, date, base);
      const ids = base.teacherIds.filter(id => { const x = tOf(d, id); return x && x.status === 'active'; });
      const teachers = ids.map(id => ({ id, name: nameOf(d, id) }));
      const pick = e => ({ teacherId: e.teacherId, day: e.day, period: e.period, type: e.type, cls: clsOf(e), swap: !!e.swapId });
      const daySwaps = list(d).filter(s => s.status === 'approved' && s.date === date && (s.a.deptId === dep.id || s.b.deptId === dep.id)).map(s => ({ id: s.id, kind: s.kind, kindName: KINDS[s.kind], a: { name: s.a.name, deptName: s.a.deptName, period: s.a.period, cls: s.a.cls }, b: { name: s.b.name, deptName: s.b.deptName, period: s.b.period, cls: s.b.cls } }));
      return { deptName: dep.name, date, today, dayKey: dk, study: base.days.includes(dk), schedule: { version: base.version, days: base.days.slice(), periodsByDay: structuredClone(base.periodsByDay), entries: base.entries.filter(e => ids.includes(e.teacherId)).map(pick) },
        dayEntries: base.days.includes(dk) ? eff.entries.filter(e => e.day === dk && ids.includes(e.teacherId)).map(pick) : [], teachers, daySwaps };
    });

    // خيارات طلب لحصة: معلمو المدرسة، توفر كل منهم للتغطية، وحصصه في اليوم مع إمكانية التبادل (بالفحص الكامل نفسه)
    op('swap.options', ['head', 'teacher'], async (ctx, a) => {
      const d = getDb(); const { t, dep } = needLinked(d, ctx); const sid = dep.schoolId;
      const date = String(a.date || ''), period = Number(a.period);
      if (!isDate(date)) fail('حدّد التاريخ.');
      const dk = Engine.dayKeyOf(date);
      const base = schedAt(dep, date);
      const eA = base ? base.entries.find(e => e.day === dk && e.teacherId === t.id && e.period === period && e.type === 'teach') : null;
      if (!eA) fail(`لا توجد حصة تدريس أساسية لك في الحصة ${period} في ${date}.`);
      const general = [];
      { const w = windowOf(); if (date < w.from) general.push('التاريخ مضى.'); else if (date > w.to) general.push(`التاريخ خارج الأسبوع الدراسي الحالي (من ${w.from} إلى ${w.to}).`); }
      { const r = timeReason(d, schoolIn(d, sid), date, [period]); if (r) general.push(r); }
      { const r = absentReason(d, t, date); if (r) general.push(r); }
      const out = [];
      for (const dp of deptsOfSchool(d, sid)) {
        if (dp.status === 'inactive') continue;
        const bs = schedAt(dp, date); if (!bs || !bs.days.includes(dk)) continue;
        for (const x of teachersOf(d, dp.id).filter(y => y.status === 'active' && y.id !== t.id && bs.teacherIds.includes(y.id))) {
          const cov = evaluate(d, sid, { date, kind: 'cover', teacherId: t.id, partnerId: x.id, period }, {});
          const lessons = bs.entries.filter(e => e.day === dk && e.teacherId === x.id && e.type === 'teach').sort((p, q) => p.period - q.period).map(e => {
            const ev = evaluate(d, sid, { date, kind: 'swap', teacherId: t.id, partnerId: x.id, period, partnerPeriod: e.period }, {});
            return { period: e.period, cls: clsOf(e), ok: ev.ok, why: ev.ok ? '' : ev.errors[0] };
          });
          out.push({ id: x.id, name: x.name, deptId: dp.id, deptName: dp.name, cover: { ok: cov.ok, why: cov.ok ? '' : cov.errors[0] }, lessons });
        }
      }
      out.sort((p, q) => (p.deptId === dep.id ? 0 : 1) - (q.deptId === dep.id ? 0 : 1) || p.deptName.localeCompare(q.deptName, 'ar') || p.name.localeCompare(q.name, 'ar'));
      return { date, dayName: Engine.DAY_NAMES[dk], period, cls: clsOf(eA), ownDeptId: dep.id, teachers: out, generalErrors: general };
    });
    const reqOf = (t, a) => ({ date: String(a.date || ''), kind: a.kind, teacherId: t.id, partnerId: String(a.partnerId || ''), period: Number(a.period), partnerPeriod: a.partnerPeriod == null ? null : Number(a.partnerPeriod), cls: a.cls == null ? null : String(a.cls), partnerCls: a.partnerCls == null ? null : String(a.partnerCls) });
    op('swap.preview', ['head', 'teacher'], async (ctx, a) => {
      const d = getDb(); const { t, dep } = needLinked(d, ctx);
      const ev = evaluate(d, dep.schoolId, reqOf(t, a), {});
      return { ok: ev.ok, errors: ev.errors, req: ev.req || null, before: ev.before || null, after: ev.after || null, kindName: KINDS[a.kind] || '' };
    });
    op('swap.create', ['head', 'teacher'], async (ctx, a) => tx(d => {
      const { t, dep } = needLinked(d, ctx);
      const ev = evaluate(d, dep.schoolId, reqOf(t, a), {});
      if (!ev.ok) fail(ev.errors.join(' '), 'conflict');
      const note = String(a.note || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      const s = { id: uid('sw'), schoolId: dep.schoolId, date: ev.req.date, kind: ev.req.kind, status: 'pending', a: ev.req.a, b: ev.req.b, note, baseVersions: ev.req.baseVersions,
        createdAt: iso(), createdBy: { accountId: ctx.id, name: ctx.name, role: ctx.role === 'teacher' ? 'teacher' : ctx.kind }, decision: null, withdrawn: null, cancel: null, events: [] };
      pushEvent(d, s, 'created', ctx);
      d.swaps = list(d).concat([s]);
      audit(d, ctx, 'طلب تبديل حصة', `${KINDS[s.kind]} — ${describe(s)}${note ? ' — ملاحظة: ' + note : ''}`, auditDept(ctx, s), { swapId: s.id, date: s.date });
      return { id: s.id, swap: view(d, s, ctx) };
    }));
    // القرار: أول قرار نهائي صحيح يغلق الطلب. الموافقة تعيد الفحص الكامل (التوفر قد تغيّر منذ الإرسال)، والإدارة لا تتجاوز تعارضًا زمنيًا
    op('swap.decide', ['admin', 'head', 'teacher'], async (ctx, a) => tx(d => {
      const s = list(d).find(x => x.id === a.id); if (!s) fail('الطلب غير موجود.', 'not_found');
      const me = linkedOf(d, ctx);
      let as = null;
      if (me && me.id === s.b.teacherId) as = 'partner';
      else { const g = adminGrant(ctx, s.schoolId); if (g) { as = 'admin'; if (g.grant) ctx.usedGrant = g.grant; } }
      if (!as) fail('لا تملك صلاحية القرار في هذا الطلب.', 'forbidden');
      if (s.status !== 'pending') fail(`أُغلق هذا الطلب مسبقًا (${STATUS[s.status]}${s.decision ? ' — ' + s.decision.name : ''}). لا يمكن اتخاذ قرار آخر عليه.`, 'conflict');
      const action = a.action === 'approve' ? 'approve' : a.action === 'reject' ? 'reject' : null;
      if (!action) fail('اختر الموافقة أو الرفض.');
      if (statusOf(s) === 'expired') fail('مضى تاريخ الطلب دون قرار؛ لا يمكن اعتماده الآن.', 'conflict');
      const reason = String(a.reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (action === 'approve') {
        const ev = evaluate(d, s.schoolId, { date: s.date, kind: s.kind, teacherId: s.a.teacherId, partnerId: s.b.teacherId, period: s.a.period, partnerPeriod: s.b.period, cls: s.a.cls, partnerCls: s.kind === 'swap' ? s.b.cls : null }, { except: s.id, decision: true });
        if (!ev.ok) fail('لا يمكن اعتماد الطلب الآن: ' + ev.errors.join(' '), 'conflict');
      }
      s.status = action === 'approve' ? 'approved' : 'rejected';
      s.decision = { action, as, accountId: ctx.id || 'admin', name: ctx.name, role: ctx.role, roleName: ROLE_NAME(ctx) + (as === 'partner' ? ' (المعلم الآخر)' : ''), at: iso(), reason, via: ctx.usedGrant ? ctx.usedGrant.grantorName : null };
      pushEvent(d, s, action === 'approve' ? 'approved' : 'rejected', ctx);
      audit(d, ctx, action === 'approve' ? 'اعتماد طلب تبديل حصة' : 'رفض طلب تبديل حصة', `${KINDS[s.kind]} — ${describe(s)} — القرار من ${as === 'partner' ? 'المعلم الآخر' : 'الإدارة'}${reason ? ' — ' + reason : ''}`, auditDept(ctx, s), { swapId: s.id, date: s.date });
      return { swap: view(d, s, ctx) };
    }));
    op('swap.withdraw', ['head', 'teacher'], async (ctx, a) => tx(d => {
      const s = list(d).find(x => x.id === a.id); if (!s) fail('الطلب غير موجود.', 'not_found');
      const me = linkedOf(d, ctx);
      if (!me || me.id !== s.a.teacherId) fail('سحب الطلب لمقدّمه فقط.', 'forbidden');
      if (s.status !== 'pending') fail(`لا يمكن سحب الطلب؛ حالته الآن: ${STATUS[s.status]}.`, 'conflict');
      s.status = 'withdrawn'; s.withdrawn = { at: iso(), name: ctx.name, accountId: ctx.id };
      pushEvent(d, s, 'withdrawn', ctx);
      audit(d, ctx, 'سحب طلب تبديل حصة', describe(s), auditDept(ctx, s), { swapId: s.id, date: s.date });
      return { swap: view(d, s, ctx) };
    }));
    /* إلغاء تبديل معتمد: مسار منفصل للإدارة المخوّلة، مع فحص الآثار: الترتيب الأصلي يجب أن يكون ممكنًا من جديد
       (لا احتياط ولا التزام صار في مكان الحصص الأصلية، ولا غياب معتمد يتأثر)، والتاريخ والحصة لم يمضيا. يبقى في السجل. */
    op('swap.cancel', ['admin', 'head'], async (ctx, a) => tx(d => {
      const s = list(d).find(x => x.id === a.id); if (!s) fail('الطلب غير موجود.', 'not_found');
      const g = adminGrant(ctx, s.schoolId); if (!g) fail('إلغاء تبديل معتمد من صلاحيات الإدارة المخوّلة فقط.', 'forbidden');
      if (g.grant) ctx.usedGrant = g.grant;
      if (s.status !== 'approved') fail(`لا يُلغى إلا تبديل معتمد؛ حالة الطلب: ${STATUS[statusOf(s)]}.`, 'conflict');
      const reason = String(a.reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!reason) fail('اكتب سبب الإلغاء.');
      const errs = [];
      const tr = timeReason(d, schoolIn(d, s.schoolId), s.date, s.kind === 'swap' ? [s.a.period, s.b.period] : [s.a.period]); if (tr) errs.push(tr);
      const A = tOf(d, s.a.teacherId), B = tOf(d, s.b.teacherId);
      for (const t of [A, B]) if (t) { const r = absentReason(d, t, s.date); if (r) errs.push(r); }
      // الترتيب الأصلي بعد الإلغاء: كل معلم يعود إلى حصته الأصلية، ويُرفع ما أخذه بالتبديل
      if (A) { const r = busyReason(d, A, s.date, s.a.period, { except: s.id, ignore: [A.id + '|' + s.a.period] }); if (r) errs.push('لا تعود الحصة الأصلية: ' + r); }
      if (s.kind === 'swap' && B) { const r = busyReason(d, B, s.date, s.b.period, { except: s.id, ignore: [B.id + '|' + s.b.period] }); if (r) errs.push('لا تعود الحصة المقابلة: ' + r); }
      // تكليف احتياط على من تحررت حصته بالتبديل يصبح متعارضًا بعد الإلغاء — فُحص أعلاه ضمن «مكلّف بحصة احتياط»
      if (errs.length) fail('لا يمكن إلغاء التبديل: ' + Array.from(new Set(errs)).join(' '), 'conflict');
      s.status = 'cancelled'; s.cancel = { at: iso(), name: ctx.name, role: ctx.role, roleName: ROLE_NAME(ctx), accountId: ctx.id || 'admin', reason, via: ctx.usedGrant ? ctx.usedGrant.grantorName : null };
      pushEvent(d, s, 'cancelled', ctx);
      audit(d, ctx, 'إلغاء تبديل حصة معتمد', `${describe(s)} — السبب: ${reason}`, auditDept(ctx, s), { swapId: s.id, date: s.date });
      return { swap: view(d, s, ctx) };
    }));
    // قائمة طلبات المدرسة للإدارة المخوّلة (مع التبديلات التي تحتاج مراجعة بعد تعديل دائم)
    op('swap.list', ['admin', 'head'], async (ctx, a) => {
      const d = getDb(); const sid = schoolOfCtx(d, ctx, a.schoolId);
      const g = adminGrant(ctx, sid); if (!g) fail('طلبات تبديل الحصص للمدرسة من صلاحيات الإدارة المخوّلة فقط.', 'forbidden');
      const sc = schoolIn(d, sid);
      const st = String(a.status || 'open');
      const all = list(d).filter(s => s.schoolId === sid).map(s => view(d, s, ctx));
      const pick = st === 'open' ? all.filter(x => x.status === 'pending' || x.review) : st === 'all' ? all : all.filter(x => x.status === st);
      pick.sort((x, y) => (x.date === y.date ? (x.createdAt < y.createdAt ? 1 : -1) : x.date < y.date ? 1 : -1));
      return { school: { id: sc.id, name: sc.name }, periodTimes: periodTimesOf(sc), canTimes: ctx.role === 'admin' || ctx.role === 'school', today: kuwaitToday(now()),
        counts: { pending: all.filter(x => x.status === 'pending').length, review: all.filter(x => x.review).length, approved: all.filter(x => x.status === 'approved').length },
        items: pick.slice(0, 300) };
    });
    // أوقات بداية الحصص (لفحص أن الحصة لم تبدأ اليوم): مدير النظام وإدارة المدرسة
    op('swap.timesSave', ['admin', 'school'], async (ctx, a) => tx(d => {
      const sid = schoolOfCtx(d, ctx, a.schoolId);
      if (!(ctx.role === 'admin' || ctx.role === 'school')) fail('تسجيل أوقات الحصص لإدارة المدرسة ومدير النظام.', 'forbidden');
      const sc = schoolIn(d, sid);
      const raw = a.times && typeof a.times === 'object' ? a.times : {};
      const out = {}; let last = '';
      for (let p = 1; p <= 20; p++) {
        const v = raw[String(p)] == null ? '' : String(raw[String(p)]).trim();
        if (!v) continue;
        if (!HHMM.test(v)) fail(`وقت الحصة ${p} غير صالح؛ اكتبه بصيغة 24 ساعة مثل 07:30.`);
        if (last && v <= last) fail(`وقت بداية الحصة ${p} يجب أن يكون بعد الحصة السابقة.`);
        out[String(p)] = v; last = v;
      }
      const before = periodTimesOf(sc);
      sc.periodTimes = out;
      audit(d, ctx, 'تسجيل أوقات بداية الحصص', `${sc.name}: ${Object.entries(out).map(([k, v]) => k + '=' + v).join('، ') || 'لا شيء'} (كانت: ${Object.entries(before).map(([k, v]) => k + '=' + v).join('، ') || 'غير مسجلة'})`, null, { schoolId: sid });
      return { periodTimes: out };
    }));

    // إشعارات الطلبات للحساب (تُدمج مع إشعارات تكليفات الإدارة)
    const EV_TITLE = { created: 'طلب تبديل حصة جديد', approved: 'اعتُمد طلب تبديل حصة', rejected: 'رُفض طلب تبديل حصة', withdrawn: 'سُحب طلب تبديل حصة', cancelled: 'أُلغي تبديل حصة معتمد' };
    function noticeItems(d, ctx, seen) {
      const out = [];
      for (const s of list(d)) for (const ev of s.events || []) if ((ev.to || []).includes(ctx.id))
        out.push({ id: ev.id, at: ev.at, unread: ev.at > seen, kind: 'swap_' + ev.kind, title: EV_TITLE[ev.kind] || 'طلب تبديل حصة', date: s.date, dayName: Engine.DAY_NAMES[Engine.dayKeyOf(s.date)],
          text: (s.kind === 'swap' ? `${s.a.name} (الحصة ${s.a.period} — ${s.a.cls}) ↔ ${s.b.name} (الحصة ${s.b.period} — ${s.b.cls})` : `تغطية حصة ${s.a.name} (الحصة ${s.a.period} — ${s.a.cls}) بواسطة ${s.b.name}`) + ` — بواسطة ${ev.actor}`,
          swapId: s.id, status: statusOf(s), statusName: STATUS[statusOf(s)] });
      return out;
    }

    return { applySwaps, effAt, noticeItems, linkedTeacherOfAcc, linkedOf, KINDS, STATUS };
  }

  const SwapOps = { install };
  if (typeof module !== 'undefined' && module.exports) module.exports = SwapOps;
  root.SwapOps = SwapOps;
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* توقيت اليوم الدراسي و«الآن في المدرسة» والمراقبات والالتزامات — عمليات الخادم.
 * التوقيت لكل مدرسة بإصدارات وتاريخ سريان (sc.bell.versions)؛ لكل إصدار نماذج توقيت (فترات بأسماء وأنواع وأوقات)
 * وتوزيع للأيام: نموذج، أو «لا دوام»، أو غير مضبوط. لا يُثبَّت عدد الحصص ولا مدتها، ولا يُعاد ترقيم حصص الجداول:
 * الحصة في الجدول ترتبط بالفترة التي تحمل رقمها في توقيت ذلك اليوم.
 * المراقبات والالتزامات بتاريخ ووقت فعلي (sc.duties) تُربط بالفترات التي يتقاطع معها وقتها، وتظهر في تاريخها فقط.
 * لا ذكاء اصطناعي أثناء التشغيل.
 */
(function (root) {
  'use strict';
  const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const TYPES = { assembly: 'طابور الصباح', lesson: 'حصة', break: 'فرصة', other: 'فترة أخرى' };
  const DUTY_KINDS = { supervision: 'مراقبة', meeting: 'اجتماع', commitment: 'التزام' };
  const ORD = ['', 'الأولى', 'الثانية', 'الثالثة', 'الرابعة', 'الخامسة', 'السادسة', 'السابعة', 'الثامنة', 'التاسعة', 'العاشرة', 'الحادية عشرة', 'الثانية عشرة'];
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  const toMin = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n || 80);
  const lessonName = n => 'الحصة ' + (ORD[n] || n);

  function install(X) {
    const { op, tx, fail, audit, iso, uid, deptIn, schoolIn, deptsOfSchool, teachersOf, Engine, kuwaitToday, now, schedAt, liveGrants } = X;
    const getDb = X.db; const SW = () => X.sw();
    const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
    const versionsOf = sc => (sc && sc.bell && Array.isArray(sc.bell.versions) ? sc.bell.versions : []);
    // الإصدار الساري في تاريخ: آخر إصدار بدأ سريانه فيه أو قبله (عند التساوي: الأحدث حفظًا)
    function versionAt(sc, date) {
      let best = null, bi = -1;
      versionsOf(sc).forEach((v, i) => { if (v.from <= date && (!best || v.from > best.from || (v.from === best.from && i > bi))) { best = v; bi = i; } });
      return best;
    }
    // توقيت تاريخ: ok (فترات) / off (لا دوام) / unset (غير مضبوط)
    function bellFor(sc, date) {
      const v = versionAt(sc, date); const dk = Engine.dayKeyOf(date);
      if (!v) return { state: 'unset', dayKey: dk, version: null, periods: [] };
      const pid = (v.days || {})[dk];
      if (pid === 'off') return { state: 'off', dayKey: dk, version: v, periods: [] };
      const pr = pid ? (v.profiles || []).find(x => x.id === pid) : null;
      if (!pr) return { state: 'unset', dayKey: dk, version: v, periods: [] };
      return { state: 'ok', dayKey: dk, version: v, profile: pr, periods: pr.periods.slice().sort((a, b) => toMin(a.start) - toMin(b.start)) };
    }
    const lessonStart = (sc, date, p) => { const b = bellFor(sc, date); if (b.state !== 'ok') return null; const x = b.periods.find(q => q.type === 'lesson' && q.lessonNo === p); return x ? x.start : null; };

    // ---------- الصلاحيات ----------
    function manageSchool(ctx, sid, perm) {
      if (ctx.role === 'admin') { if (!schoolIn(getDb(), sid)) fail('المدرسة غير موجودة.', 'not_found'); return sid; }
      if (ctx.role === 'school') { if (sid && sid !== ctx.schoolId) fail('غير مصرح لك بالوصول إلى هذه المدرسة.', 'forbidden'); return ctx.schoolId; }
      if (ctx.role === 'head') {
        const g = (ctx.grants || []).find(x => x.perms.has(perm) && (!sid || x.schoolId === sid));
        if (g) { ctx.usedGrant = g; return g.schoolId; }
      }
      fail(perm === 'supManage' ? 'إدارة المراقبة من صلاحيات مدير النظام وإدارة المدرسة أو المفوَّض بها صراحة.' : perm === 'bellManage' ? 'إدارة توقيت المدرسة من صلاحيات مدير النظام وإدارة المدرسة أو المفوَّض بها صراحة.' : 'إدارة المراقبات والالتزامات من صلاحيات مدير النظام وإدارة المدرسة أو المفوَّض بها صراحة.', 'forbidden');
    }
    // مدرسة العرض: المنظّم يحددها، والإدارة مدرستها، والقسم مدرسة قسمه
    function viewSchool(d, ctx, sid) {
      if (ctx.role === 'admin') { const sc = schoolIn(d, sid); if (!sc) fail('اختر مدرسة.', 'not_found'); return sc.id; }
      if (ctx.role === 'school') return ctx.schoolId;
      const dep = deptIn(d, ctx.deptId); if (!dep || !dep.schoolId) fail('القسم غير مرتبط بمدرسة؛ لا يوجد توقيت مدرسة له.', 'not_ready');
      return dep.schoolId;
    }

    // ---------- التحقق ----------
    function cleanVersion(a) {
      const profiles = Array.isArray(a.profiles) ? a.profiles.slice(0, 10) : [];
      if (!profiles.length) fail('أضف نموذج توقيت واحدًا على الأقل.');
      const ids = new Set(); const out = [];
      for (const [i, p0] of profiles.entries()) {
        const id = str(p0.id, 40) || 'p' + (i + 1);
        if (ids.has(id)) fail('معرّف نموذج مكرر.'); ids.add(id);
        const name = str(p0.name, 40) || 'نموذج ' + (i + 1);
        const rows = Array.isArray(p0.periods) ? p0.periods.slice(0, 30) : [];
        if (!rows.length) fail(`النموذج «${name}» بلا فترات.`);
        const periods = []; const nums = new Set();
        for (const [j, r] of rows.entries()) {
          const type = TYPES[r.type] ? r.type : null; if (!type) fail(`نوع الفترة ${j + 1} في «${name}» غير صالح.`);
          const start = String(r.start || ''), end = String(r.end || '');
          if (!HHMM.test(start) || !HHMM.test(end)) fail(`وقت الفترة ${j + 1} في «${name}» غير صالح؛ اكتبه بصيغة 24 ساعة مثل 07:30.`);
          if (toMin(end) <= toMin(start)) fail(`نهاية الفترة ${j + 1} في «${name}» يجب أن تكون بعد بدايتها.`);
          let lessonNo = null;
          if (type === 'lesson') {
            lessonNo = Number(r.lessonNo);
            if (!Number.isInteger(lessonNo) || lessonNo < 1 || lessonNo > 20) fail(`رقم الحصة للفترة ${j + 1} في «${name}» مطلوب (1 إلى 20) ويطابق رقمها في الجداول.`);
            if (nums.has(lessonNo)) fail(`رقم الحصة ${lessonNo} مكرر في «${name}».`); nums.add(lessonNo);
          }
          const nm = str(r.name, 40) || (type === 'lesson' ? lessonName(lessonNo) : TYPES[type]);
          periods.push({ id: str(r.id, 40) || 'f' + (j + 1), name: nm, type, lessonNo, start, end });
        }
        periods.sort((x, y) => toMin(x.start) - toMin(y.start));
        for (let k = 1; k < periods.length; k++) if (toMin(periods[k].start) < toMin(periods[k - 1].end))
          fail(`تداخل في «${name}»: «${periods[k - 1].name}» (${periods[k - 1].start}–${periods[k - 1].end}) و«${periods[k].name}» (${periods[k].start}–${periods[k].end}). الفجوات مسموحة، والتداخل لا.`);
        out.push({ id, name, periods });
      }
      const days = {}; const rawD = a.days && typeof a.days === 'object' ? a.days : {};
      for (const k of DAY_KEYS) { const v = rawD[k]; if (v == null || v === '') continue; if (v === 'off') days[k] = 'off'; else if (out.some(p => p.id === v)) days[k] = v; else fail('يوم مرتبط بنموذج غير موجود.'); }
      if (!Object.values(days).some(v => v !== 'off')) fail('اربط يومًا دراسيًا واحدًا على الأقل بنموذج توقيت.');
      return { profiles: out, days };
    }
    // ما يتأثر بالتوقيت الجديد ويُعرض للمراجعة: مراقبات/التزامات لم يعد وقتها يقع في فترات يومها، وحصص في الجداول بلا فترة بالرقم نفسه
    function reviewFor(d, sc, from) {
      const out = [];
      for (const x of (sc.duties || []).filter(y => y.status === 'active' && y.date >= from)) {
        const b = bellFor(sc, x.date);
        if (b.state !== 'ok') out.push({ kind: 'duty', id: x.id, text: `${DUTY_KINDS[x.kind]} «${x.title}» بتاريخ ${x.date} (${x.start}–${x.end}): ${b.state === 'off' ? 'اليوم صار بلا دوام' : 'لا يوجد توقيت مضبوط لذلك اليوم'}.` });
        else if (!b.periods.some(p => toMin(x.start) < toMin(p.end) && toMin(x.end) > toMin(p.start))) out.push({ kind: 'duty', id: x.id, text: `${DUTY_KINDS[x.kind]} «${x.title}» بتاريخ ${x.date} (${x.start}–${x.end}) لا يقع في أي فترة من توقيت ذلك اليوم.` });
      }
      const v = versionAt(sc, '9999-12-31');
      if (v) for (const dep of deptsOfSchool(d, sc.id)) {
        const cur = dep.scheduleApproved; if (!cur || !cur.periodsByDay) continue;
        for (const dk of cur.days || []) {
          const pid = (v.days || {})[dk]; const pr = pid && pid !== 'off' ? v.profiles.find(p => p.id === pid) : null;
          if (!pr) continue;
          const miss = (cur.periodsByDay[dk] || []).filter(n => !pr.periods.some(p => p.type === 'lesson' && p.lessonNo === n));
          if (miss.length) out.push({ kind: 'lesson', text: `جدول قسم «${dep.name}» فيه الحصة ${miss.join('، ')} يوم ${Engine.DAY_NAMES[dk]}، ولا توجد فترة بهذا الرقم في توقيت آخر إصدار.` });
        }
      }
      return out;
    }
    const vView = v => ({ id: v.id, from: v.from, at: v.at, by: v.by, byRole: v.byRole || '', note: v.note || '', days: { ...(v.days || {}) }, profiles: structuredClone(v.profiles || []) });

    // ---------- العمليات ----------
    op('auth.clock', null, async () => ({ now: iso() }));
    op('bell.get', ['admin', 'head'], async (ctx, a) => {
      const d = getDb(); const sid = manageSchool(ctx, a.schoolId, 'bellManage'); const sc = schoolIn(d, sid);
      const today = kuwaitToday(now()); const cur = versionAt(sc, today);
      const vs = versionsOf(sc).map(vView).sort((x, y) => (x.from === y.from ? (x.at < y.at ? 1 : -1) : x.from < y.from ? 1 : -1));
      return { school: { id: sc.id, name: sc.name }, today, current: cur ? vView(cur) : null, upcoming: vs.filter(v => v.from > today), versions: vs, types: TYPES, review: versionsOf(sc).length ? reviewFor(d, sc, today).concat(supIssues(d, sc).map(x => ({ kind: 'sup', id: x.id, text: 'مراقبة أسبوعية: ' + x.text }))) : [] };
    });
    op('bell.save', ['admin', 'head'], async (ctx, a) => tx(d => {
      const sid = manageSchool(ctx, a.schoolId, 'bellManage'); const sc = schoolIn(d, sid);
      const today = kuwaitToday(now());
      const from = String(a.from || '');
      if (!isDate(from)) fail('حدّد تاريخ بدء السريان.');
      if (from < today) fail('تاريخ السريان لا يكون في الماضي؛ التوقيت السابق يبقى كما هو للأيام الماضية.');
      const c = cleanVersion(a);
      const v = { id: uid('bell'), from, at: iso(), by: ctx.name, byRole: ctx.role === 'admin' ? 'مدير النظام' : ctx.role === 'school' ? (ctx.kind === 'assistant' ? 'مساعد المدير' : 'مدير المدرسة') : 'مفوَّض', note: str(a.note, 200), ...c };
      sc.bell = { versions: versionsOf(sc).concat([v]) };
      const review = reviewFor(d, sc, from).concat(supIssues(d, sc).map(x => ({ kind: 'sup', id: x.id, text: 'مراقبة أسبوعية: ' + x.text })));
      const dayTxt = DAY_KEYS.filter(k => v.days[k]).map(k => Engine.DAY_NAMES[k] + ': ' + (v.days[k] === 'off' ? 'لا دوام' : v.profiles.find(p => p.id === v.days[k]).name)).join('، ');
      audit(d, ctx, 'اعتماد توقيت اليوم الدراسي', `${sc.name} — يسري من ${from} — ${v.profiles.map(p => `${p.name} (${p.periods.length} فترة، ${p.periods[0].start}–${p.periods[p.periods.length - 1].end})`).join('؛ ')} — ${dayTxt}${review.length ? ` — للمراجعة: ${review.length}` : ''}`, null, { schoolId: sid });
      return { version: vView(v), review };
    }));

    // تكليفات معلم في تاريخ مربوطة بفترات التوقيت (تدريس، تبديل، احتياط، مراقبة، التزام). التعارض يُظهر الكل
    function assignFor(d, sc, t, date, b) {
      const dep = deptIn(d, t.deptId); const dk = Engine.dayKeyOf(date);
      const items = [];
      const base = schedAt(dep, date);
      if (base && base.days.includes(dk)) {
        const eff = SW().applySwaps(d, dep, date, base);
        for (const e of eff.entries) if (e.day === dk && e.teacherId === t.id) {
          const cls = e.cls == null ? '' : String(e.cls).trim();
          items.push({ by: 'lesson', no: e.period, kind: e.type === 'teach' ? 'teach' : 'commit', label: e.type === 'teach' ? `تدريس — الصف ${cls || '—'}` : ({ meeting: 'اجتماع', task: 'مهمة', work: 'عمل', fixed: 'التزام ثابت' }[e.type] || 'التزام'), swap: !!e.swapId });
        }
      }
      for (const rec of d.days) if (rec.date === date) for (const sl of (rec.result && rec.result.slots) || []) if (sl && sl.teacherId === t.id && sl.status === 'covered')
        items.push({ by: 'lesson', no: sl.period, kind: 'reserve', label: `احتياط — الصف ${sl.cls == null ? '—' : sl.cls}`, from: 'القسم' });
      for (const x of (Array.isArray(d.adminAssigns) ? d.adminAssigns : [])) if (x.state === 'assigned' && x.teacherId === t.id && x.date === date)
        items.push({ by: 'lesson', no: x.period, kind: 'reserve', label: `احتياط — الصف ${x.cls == null ? '—' : x.cls}`, from: 'الإدارة' });
      for (const x of (sc.duties || [])) if (x.status === 'active' && x.date === date && (x.teacherIds || []).includes(t.id))
        items.push({ by: 'time', start: x.start, end: x.end, kind: x.kind === 'supervision' ? 'duty' : 'commit', label: `${DUTY_KINDS[x.kind]} — ${x.title}${x.place ? ' (' + x.place + ')' : ''}` });
      for (const x of supOn(sc, t.id, date)) for (const p of x.breaks) items.push({ by: 'pid', pid: p.id, kind: 'duty', label: `${x.kind === 'rot' ? 'مراقبة بالدور' : 'مراقبة أسبوعية'} — ${x.place}` });
      const byPeriod = {}; const outside = [];
      for (const it of items) {
        let hit = [];
        if (b.state === 'ok') hit = it.by === 'pid' ? b.periods.filter(p => p.id === it.pid) : it.by === 'lesson' ? b.periods.filter(p => p.type === 'lesson' && p.lessonNo === it.no) : b.periods.filter(p => toMin(it.start) < toMin(p.end) && toMin(it.end) > toMin(p.start));
        const view = { kind: it.kind, label: it.label, swap: !!it.swap, from: it.from || null };
        if (!hit.length) outside.push({ ...view, when: it.by === 'lesson' ? 'الحصة ' + it.no : it.start + '–' + it.end });
        for (const p of hit) (byPeriod[p.id] = byPeriod[p.id] || []).push(view);
      }
      return { byPeriod, outside, deptName: dep.name };
    }

    op('bell.today', ['admin', 'head', 'teacher'], async (ctx, a) => {
      const d = getDb();
      // مدير النظام المربوط بسجل معلم: مدرسة سجله افتراضيًا (من صفحة المدارس)، وتكليفاته في أي مدرسة يفتحها هي مدرسته
      const at = ctx.role === 'admin' && X.adminTeacher ? X.adminTeacher(d) : null;
      const atSid = at ? (deptIn(d, at.deptId) || {}).schoolId || null : null;
      const sid = viewSchool(d, ctx, a.schoolId || (ctx.role === 'admin' ? atSid : null)); const sc = schoolIn(d, sid);
      const today = kuwaitToday(now());
      const date = isDate(a.date) ? a.date : today;
      const b = bellFor(sc, date);
      const t = ctx.role === 'admin' ? (at && atSid === sid ? at : null) : SW().linkedOf(d, ctx);
      const res = { serverNow: iso(), school: { id: sc.id, name: sc.name }, date, today, dayKey: b.dayKey, dayName: Engine.DAY_NAMES[b.dayKey],
        bell: { state: b.state, versionId: b.version ? b.version.id : null, from: b.version ? b.version.from : null, updatedAt: b.version ? b.version.at : null, profileName: b.profile ? b.profile.name : null,
          periods: b.periods.map(p => ({ id: p.id, name: p.name, type: p.type, lessonNo: p.lessonNo, start: p.start, end: p.end })) },
        linked: !!t, teacherName: t ? t.name : null };
      if (t) res.assign = assignFor(d, sc, t, date, b);
      return res;
    });

    // ---------- ودجت شاشة القفل (تطبيق Scriptable على الآيفون) ----------
    // توقيت المدرسة فقط (أسماء الفترات وأوقاتها) لسبعة أيام، بلا أي بيانات معلمين أو تكليفات، بمفتاح قراءة خاص بالمدرسة.
    // المفتاح يُنشأ أو يُجدَّد (فيلغى القديم) من «توقيت اليوم الدراسي» بصلاحية إدارته.
    const WKEY = /^[A-Za-z0-9_-]{24,64}$/;
    const newWidgetKey = () => { const a = new Uint8Array(24); root.crypto.getRandomValues(a); return Array.from(a, x => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[x & 63]).join(''); };
    op('widget.key', ['admin', 'head'], async (ctx, a) => tx(d => {
      const sid = manageSchool(ctx, a.schoolId, 'bellManage'); const sc = schoolIn(d, sid);
      const rotate = a.rotate === true;
      if (!sc.widgetKey || rotate) {
        const had = !!sc.widgetKey; sc.widgetKey = newWidgetKey();
        audit(d, ctx, had ? 'تجديد مفتاح ودجت التوقيت' : 'إنشاء مفتاح ودجت التوقيت', `${sc.name} — ${had ? 'أُلغي المفتاح السابق' : 'مفتاح جديد'} (توقيت اليوم فقط، بلا بيانات شخصية)`, null, { schoolId: sid });
      }
      return { key: sc.widgetKey, school: { id: sc.id, name: sc.name } };
    }));
    // «حسابي»: كود الودجت لكل مستخدم. المرتبط بسجل معلم (المعلم ورئيس القسم ونائبه) يأخذ كودًا شخصيًا يعرض توقيت المدرسة
    // وتكليفاته هو (تدريس، احتياط، مراقبة، التزامات)، يُنشأ عند أول طلب ويجدده صاحبه (rotate) فيلغى القديم. غيره (مدير المدرسة ومساعده) يأخذ كود المدرسة (توقيت فقط) إن أنشأته الإدارة.
    op('widget.my', ['admin', 'head', 'teacher'], async (ctx, a) => tx(d => {
      const sid = viewSchool(d, ctx, a.schoolId); const sc = schoolIn(d, sid);
      const school = { id: sc.id, name: sc.name };
      const t = ctx.role === 'admin' ? null : SW().linkedOf(d, ctx);
      if (!t) return { personal: false, key: sc.widgetKey || null, school };
      const acc = d.accounts.find(x => x.id === ctx.id); if (!acc) fail('الحساب غير موجود.', 'not_found');
      if (!acc.widgetKey || a.rotate === true) acc.widgetKey = newWidgetKey();
      return { personal: true, key: acc.widgetKey, school };
    }));
    op('widget.bell', null, async (ctx, a) => {
      const k = String((a && a.k) || '');
      if (!WKEY.test(k)) fail('مفتاح الودجت غير صالح.', 'not_found');
      const d = getDb(); let sc = (d.schools || []).find(x => x && x.widgetKey === k && x.status !== 'disabled'); let t = null;
      // كود شخصي: حساب نشط مرتبط بسجل معلم نشط (تعطيل الحساب أو أرشفة المعلم يوقف الكود)
      if (!sc) {
        const acc = (d.accounts || []).find(x => x && x.widgetKey === k && x.status === 'active');
        t = acc ? SW().linkedOf(d, { role: acc.kind === 'teacher' ? 'teacher' : 'head', id: acc.id }) : null;
        const dep = t ? deptIn(d, t.deptId) : null; sc = dep && dep.schoolId ? schoolIn(d, dep.schoolId) : null;
        if (sc && sc.status === 'disabled') sc = null;
      }
      if (!sc) fail('مفتاح الودجت غير صالح أو أُلغي. انسخ الكود الجديد من «حسابي» أو «توقيت اليوم الدراسي».', 'not_found');
      const today = kuwaitToday(now()); const days = [];
      for (let i = 0; i < 7; i++) {
        const z = new Date(today + 'T12:00:00Z'); z.setUTCDate(z.getUTCDate() + i); const date = z.toISOString().slice(0, 10);
        const b = bellFor(sc, date);
        const as = t && b.state === 'ok' ? assignFor(d, sc, t, date, b) : null;
        // تكليفاتي في كل فترة: الوصف فقط (لا أسماء ولا معرّفات)
        const mine = p => (as && as.byPeriod[p.id] ? as.byPeriod[p.id].map(i => i.label + (i.swap ? ' (تبديل مؤقت)' : '')) : []);
        days.push({ date, dayName: Engine.DAY_NAMES[b.dayKey], state: b.state, periods: b.state === 'ok' ? b.periods.map(p => (t ? { name: p.name, type: p.type, start: p.start, end: p.end, mine: mine(p) } : { name: p.name, type: p.type, start: p.start, end: p.end })) : [] });
      }
      return { v: 1, serverNow: iso(), school: sc.name, today, personal: !!t, days };
    });

    // ---------- المراقبات والالتزامات ----------
    const dutyView = (d, x) => ({ id: x.id, kind: x.kind, kindName: DUTY_KINDS[x.kind], title: x.title, place: x.place || '', date: x.date, start: x.start, end: x.end, note: x.note || '', status: x.status,
      teachers: (x.teacherIds || []).map(id => ({ id, name: (d.teachers.find(y => y.id === id) || {}).name || '—' })), by: x.by, at: x.at, cancel: x.cancel || null });
    op('duty.list', ['admin', 'head'], async (ctx, a) => {
      const d = getDb(); const sid = manageSchool(ctx, a.schoolId, 'dutyManage'); const sc = schoolIn(d, sid);
      const today = kuwaitToday(now());
      const from = isDate(a.from) ? a.from : today;
      const items = (sc.duties || []).filter(x => x.date >= from).sort((x, y) => (x.date === y.date ? (x.start < y.start ? -1 : 1) : x.date < y.date ? -1 : 1)).slice(0, 300).map(x => dutyView(d, x));
      const teachers = []; for (const dep of deptsOfSchool(d, sid)) for (const t of teachersOf(d, dep.id).filter(y => y.status === 'active')) teachers.push({ id: t.id, name: t.name, deptName: dep.name });
      return { school: { id: sc.id, name: sc.name }, today, from, items, teachers, canSup: ctx.role === 'admin' || ctx.role === 'school' || (ctx.grants || []).some(g => g.schoolId === sid && g.perms.has('supManage')), kinds: { meeting: DUTY_KINDS.meeting, commitment: DUTY_KINDS.commitment } };
    });
    op('duty.save', ['admin', 'head'], async (ctx, a) => tx(d => {
      const sid = manageSchool(ctx, a.schoolId, 'dutyManage'); const sc = schoolIn(d, sid);
      const today = kuwaitToday(now());
      // المراقبة لها نظام واحد في صفحة «المراقبة» (المرافق والتوزيع الأسبوعي والتلقائي)؛ هنا الاجتماعات والالتزامات فقط
      if (a.kind === 'supervision') fail('المراقبة تُدار من صفحة «المراقبة» (المرافق والتوزيع الأسبوعي أو التلقائي)، لا من الاجتماعات والالتزامات.', 'moved');
      const kind = DUTY_KINDS[a.kind] ? a.kind : null; if (!kind) fail('اختر النوع: اجتماع أو التزام.');
      const title = str(a.title, 80); if (title.length < 2) fail('اكتب الموضوع أو المادة.');
      const date = String(a.date || ''); if (!isDate(date)) fail('حدّد التاريخ.'); if (date < today) fail('لا يُسجَّل تكليف لتاريخ مضى.');
      const start = String(a.start || ''), end = String(a.end || '');
      if (!HHMM.test(start) || !HHMM.test(end) || toMin(end) <= toMin(start)) fail('حدّد وقت البداية والنهاية (النهاية بعد البداية).');
      const inSchool = new Set(deptsOfSchool(d, sid).map(x => x.id));
      const ids = Array.from(new Set((Array.isArray(a.teacherIds) ? a.teacherIds : []).map(String))).slice(0, 60);
      if (!ids.length) fail('اختر معلمًا واحدًا على الأقل.');
      for (const id of ids) { const t = d.teachers.find(y => y.id === id); if (!t || !inSchool.has(t.deptId) || t.status !== 'active') fail('معلم ليس من معلمي المدرسة الفعّالين.', 'forbidden'); }
      for (const id of ids) for (const sv of supOn(sc, id, date)) for (const p of sv.breaks) if (toMin(start) < toMin(p.end) && toMin(end) > toMin(p.start))
        fail(`«${(d.teachers.find(y => y.id === id) || {}).name}» مكلّف ب${sv.kind === 'rot' ? 'مراقبة بالدور' : 'مراقبة أسبوعية'} (${sv.place}) في ${p.name} ${p.start}–${p.end} بالتاريخ نفسه. اختر وقتًا آخر أو عدّل المراقبة.`, 'conflict');
      const x = { id: uid('duty'), kind, title, place: str(a.place, 80), date, start, end, teacherIds: ids, note: str(a.note, 200), status: 'active', by: ctx.name, at: iso() };
      sc.duties = (sc.duties || []).concat([x]);
      const b = bellFor(sc, date);
      const warn = b.state !== 'ok' ? (b.state === 'off' ? 'اليوم بلا دوام في توقيت المدرسة.' : 'لا يوجد توقيت مضبوط لذلك اليوم؛ يظهر التكليف خارج الفترات.') : !b.periods.some(p => toMin(start) < toMin(p.end) && toMin(end) > toMin(p.start)) ? 'الوقت لا يقع في أي فترة من توقيت ذلك اليوم.' : null;
      audit(d, ctx, 'تسجيل ' + DUTY_KINDS[kind], `${sc.name} — ${title}${x.place ? ' (' + x.place + ')' : ''} — ${date} ${start}–${end} — ${ids.map(id => (d.teachers.find(y => y.id === id) || {}).name).join('، ')}`, null, { schoolId: sid });
      return { duty: dutyView(d, x), warn };
    }));
    op('duty.cancel', ['admin', 'head'], async (ctx, a) => tx(d => {
      const sid = manageSchool(ctx, a.schoolId, 'dutyManage'); const sc = schoolIn(d, sid);
      const x = (sc.duties || []).find(y => y.id === a.id); if (!x) fail('التكليف غير موجود.', 'not_found');
      if (x.status !== 'active') fail('التكليف ملغى مسبقًا.');
      x.status = 'cancelled'; x.cancel = { at: iso(), by: ctx.name, reason: str(a.reason, 200) };
      audit(d, ctx, 'إلغاء ' + DUTY_KINDS[x.kind], `${sc.name} — ${x.title} — ${x.date} ${x.start}–${x.end}${x.cancel.reason ? ' — ' + x.cancel.reason : ''}`, null, { schoolId: sid });
      return { ok: true };
    }));

    // ================= المراقبة الأسبوعية =================
    /* أماكن المراقبة (sc.supPlaces) وتكليفات أسبوعية (sc.supAssigns): معلم + مكان + يوم + فرصة (معرّف الفترة في توقيت اليوم، أو «كل فرص اليوم»)
       بتاريخ بدء وتاريخ نهاية اختياري. لكل معلم يوم مراقبة واحد في الأسبوع ضمن الفترة الفعالة. لا تُدخل في الجداول ولا تمس الدين والدور. */
    const places = sc => (Array.isArray(sc.supPlaces) ? sc.supPlaces : []);
    const supList = sc => (Array.isArray(sc.supAssigns) ? sc.supAssigns : []);
    const isLive = a => a.status === 'active';
    const addD = (ds, n) => { const x = new Date(ds + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
    const breaksOf = b => (b.state === 'ok' ? b.periods.filter(p => p.type === 'break') : []);
    const afterLesson = (b, p) => { let n = null; for (const q of b.periods) if (q.type === 'lesson' && toMin(q.end) <= toMin(p.start) && (n == null || q.lessonNo > n)) n = q.lessonNo; return n; };
    // فرص تكليف في تاريخ (حسب التوقيت الساري فيه). breakId '*' = كل فرص اليوم
    const supBreaks = (b, a) => (a.breakId === '*' ? breaksOf(b) : breaksOf(b).filter(p => p.id === a.breakId));
    // المرفق المعطّل لا تُطبَّق فيه المراقبة (التكليفات تبقى في السجل)، والتكليف الأسبوعي يسري ما دام نظام المرفق أسبوعيًا في التاريخ
    const placeOn = (sc, pid) => { const p = places(sc).find(x => x.id === pid); return !!p && p.status === 'active'; };
    const covers = (a, date, sc) => isLive(a) && a.from <= date && (!a.to || a.to >= date) && a.dayKey === Engine.dayKeyOf(date) && (!sc || (placeOn(sc, a.placeId) && cfgAt(places(sc).find(x => x.id === a.placeId), date).system === 'weekly'));
    const rotLog = sc => (Array.isArray(sc.supRotLog) ? sc.supRotLog : []);
    function supOn(sc, teacherId, date) {
      const b = bellFor(sc, date); const out = [];
      for (const a of supList(sc)) if (a.teacherId === teacherId && covers(a, date, sc)) {
        const pl = places(sc).find(x => x.id === a.placeId) || { name: '—' };
        out.push({ id: a.id, kind: 'weekly', place: pl.name, breaks: supBreaks(b, a).map(p => ({ id: p.id, name: p.name, start: p.start, end: p.end })), missing: b.state === 'ok' && !supBreaks(b, a).length, dayOff: b.state !== 'ok' });
      }
      // المراقبة بالدور: التكليفات المعتمدة فقط (المسودة لا تظهر للمعلم)
      for (const r of rotLog(sc)) if (r.teacherId === teacherId && r.date === date && r.status !== 'cancelled') {
        const pl = places(sc).find(x => x.id === r.placeId) || { name: r.placeName || '—' };
        const p = b.state === 'ok' ? b.periods.find(q => q.id === r.pid) : null;
        out.push({ id: r.id, kind: 'rot', place: pl.name, breaks: p ? [{ id: p.id, name: p.name, start: p.start, end: p.end }] : [], missing: !p, dayOff: b.state !== 'ok' });
      }
      return out;
    }
    // ما يحتاجه «جدولي»: فرص اليوم وموضعها بين الحصص، ومراقبات المعلم فيها
    function dayInfo(sc, date, teacherId) {
      if (!sc) return { state: 'unset', breaks: [], sup: [] };
      const b = bellFor(sc, date);
      return { state: b.state, breaks: breaksOf(b).map(p => ({ id: p.id, name: p.name, start: p.start, end: p.end, afterLesson: afterLesson(b, p) })),
        sup: teacherId ? supOn(sc, teacherId, date).filter(x => x.breaks.length).map(x => ({ place: x.place, kind: x.kind, breaks: x.breaks })) : [] };
    }
    // أول تاريخ للتكليف من تاريخ معيّن (لفحص ربطه بالتوقيت الساري)
    const nextDate = (a, fromDate) => { let d = a.from > fromDate ? a.from : fromDate; for (let i = 0; i < 7; i++) { if (Engine.dayKeyOf(d) === a.dayKey) return !a.to || d <= a.to ? d : null; d = addD(d, 1); } return null; };
    function supIssues(d, sc) {
      const today = kuwaitToday(now()); const out = [];
      const starts = [today].concat(versionsOf(sc).map(v => v.from).filter(f => f > today)).sort();
      for (const a of supList(sc).filter(isLive)) {
        // أول موعد للتكليف تحت كل إصدار توقيت قادم: أول موعد متأثر يُعرض
        let dt = null, b = null;
        for (const f of starts) { const x = nextDate(a, f); if (!x) continue; const bx = bellFor(sc, x); if (bx.state !== 'ok' || !supBreaks(bx, a).length) { dt = x; b = bx; break; } }
        if (!dt) continue; const t = d.teachers.find(x => x.id === a.teacherId); const pl = places(sc).find(x => x.id === a.placeId);
        const who = `${t ? t.name : '—'} (${pl ? pl.name : '—'} — ${Engine.DAY_NAMES[a.dayKey]})`;
        if (b.state === 'off') out.push({ id: a.id, text: `${who}: يوم ${Engine.DAY_NAMES[a.dayKey]} صار بلا دوام في توقيت ${dt}.` });
        else if (b.state === 'unset') out.push({ id: a.id, text: `${who}: لا يوجد توقيت مضبوط ليوم ${Engine.DAY_NAMES[a.dayKey]} (${dt}).` });
        else if (!supBreaks(b, a).length) out.push({ id: a.id, text: `${who}: الفرصة المرتبطة «${a.breakName || ''}» لم تعد في توقيت ${Engine.DAY_NAMES[a.dayKey]} الساري (${dt}). عدّل التكليف لاختيار الفرصة.` });
      }
      // تكليفات بالدور معتمدة لتاريخ قادم تغيّر توقيت فرصتها: الوقت يتبع التوقيت الجديد، وإن حُذفت الفرصة يُعرض للمراجعة
      for (const r of (Array.isArray(sc.supRotLog) ? sc.supRotLog : []).filter(x => x.date >= today && x.status !== 'cancelled')) {
        const b = bellFor(sc, r.date); const p = b.state === 'ok' ? b.periods.find(q => q.id === r.pid) : null;
        if (!p) { const t = d.teachers.find(x => x.id === r.teacherId); const pl = places(sc).find(x => x.id === r.placeId); out.push({ id: r.id, text: `${t ? t.name : '—'} (${pl ? pl.name : r.placeName} — مراقبة بالدور ${r.date}): فرصة «${r.breakName}» لم تعد في توقيت ذلك اليوم.` }); }
      }
      return out;
    }
    const supView = (d, sc, a) => {
      const t = d.teachers.find(x => x.id === a.teacherId); const dep = t ? deptIn(d, t.deptId) : null; const pl = places(sc).find(x => x.id === a.placeId);
      const dt = nextDate(a, kuwaitToday(now())); const b = dt ? bellFor(sc, dt) : null; const br = b ? supBreaks(b, a) : [];
      return { id: a.id, placeId: a.placeId, placeName: pl ? pl.name : '—', teacherId: a.teacherId, teacherName: t ? t.name : '—', deptName: dep ? dep.name : '', dayKey: a.dayKey, dayName: Engine.DAY_NAMES[a.dayKey],
        breakId: a.breakId, breakName: a.breakId === '*' ? 'كل فرص اليوم' : (br[0] ? br[0].name : (a.breakName || '—')), times: br.map(p => p.start + '–' + p.end), from: a.from, to: a.to || null, status: a.status, by: a.by, at: a.at, history: a.history || [] };
    };

    // ================= نظام المراقبة لكل مرفق: أسبوعي ثابت أو تلقائي بالدور =================
    /* لكل مرفق إعدادات بتاريخ سريان (place.cfgs): النظام، والمشاركون بترتيبهم، والأيام، والفرصة (بالاسم أو كل الفرص)،
       وأول معلم يبدأ الدور، وعدد المراقبين المطلوبين في كل فرصة. الإعداد السابق يبقى محفوظًا.
       الدور لكل مرفق (sc.supRot[placeId].queue): طابور دائري مستمر بين الأيام والأسابيع؛ المُسنَد ينتقل لآخر الطابور،
       وغير المتاح يبقى مكانه فلا يُعتبر أخذ دوره. لا يتحرك الطابور إلا بالاعتماد. مستقل عن دور الاحتياط والدين. */
    function cfgAt(p, date) {
      let best = null;
      for (const c of (p && Array.isArray(p.cfgs) ? p.cfgs : [])) if (c.from <= date && (!best || c.from > best.from || (c.from === best.from && c.at >= best.at))) best = c;
      return best || { id: 'legacy', system: 'weekly', from: '0000-01-01' };
    }
    const rotState = sc => (sc.supRot && typeof sc.supRot === 'object' ? sc.supRot : {});
    const rotDays = sc => (Array.isArray(sc.supRotDays) ? sc.supRotDays : []);
    const placesOrdered = sc => places(sc).map((p, i) => ({ p, i })).sort((x, y) => ((x.p.order != null ? x.p.order : x.i) - (y.p.order != null ? y.p.order : y.i))).map(x => x.p);
    const tName = (d, id) => (d.teachers.find(x => x.id === id) || {}).name || '—';
    // الطابور المطبّق لإعداد: يحفظ الترتيب المستمر من الطابور السابق، ويضيف الجدد بترتيبهم، ويبدأ بالمعلم المحدد عند بدء إعداد جديد
    function queueFor(st, cfg) {
      const parts = cfg.participants || [];
      if (st && st.cfgId === cfg.id) { const q = st.queue.filter(id => parts.includes(id)); parts.forEach(id => { if (!q.includes(id)) q.push(id); }); return q; }
      let q = st ? st.queue.filter(id => parts.includes(id)) : [];
      parts.forEach(id => { if (!q.includes(id)) q.push(id); });
      if (!st || !st.queue.length) q = parts.slice();
      if (cfg.start && q.includes(cfg.start)) { const k = q.indexOf(cfg.start); q = q.slice(k).concat(q.slice(0, k)); }
      return q;
    }
    // فرص مرفق بالدور في تاريخ (من توقيت ذلك اليوم، دون إدخال وقت)
    function rotBreaks(sc, cfg, date) {
      const b = bellFor(sc, date);
      if (b.state === 'off') return { err: 'لا يوجد دوام في هذا اليوم.' };
      if (b.state !== 'ok') return { err: 'لم يُضبط توقيت هذا اليوم في «توقيت اليوم الدراسي».', bell: true };
      const brs = breaksOf(b);
      if (!brs.length) return { err: 'لا توجد فرصة مضبوطة في توقيت هذا اليوم.', bell: true };
      if (cfg.brk === '*') return { list: brs };
      if (brs.length === 1) return { list: brs };
      if (!cfg.brk) return { err: 'لليوم أكثر من فرصة؛ حدّد الفرصة في إعداد المرفق.' };
      const m = brs.filter(p => p.name === cfg.brk);
      return m.length ? { list: m } : { err: `الفرصة «${cfg.brk}» غير موجودة في توقيت هذا اليوم.` };
    }
    // سبب عدم توفر معلم في فرصة تاريخ (غير التكليفات في المسودة)
    function unavailWhy(d, sc, tid, date, p) {
      const t = d.teachers.find(x => x.id === tid);
      if (!t || t.status !== 'active') return 'ليس من المعلمين الفعّالين';
      const rec = d.days.find(r => r.date === date && (r.absentIds || []).includes(tid));
      if (rec) return rec.absentPeriods && rec.absentPeriods[tid] ? 'غائب جزئيًا' : 'غائب';
      for (const x of supOn(sc, tid, date)) if (x.breaks.some(q => q.id === p.id)) return `${x.kind === 'rot' ? 'مراقبة بالدور معتمدة' : 'مراقبة أسبوعية'} في ${x.place}`;
      for (const x of (sc.duties || [])) if (x.status === 'active' && x.date === date && (x.teacherIds || []).includes(tid) && toMin(x.start) < toMin(p.end) && toMin(x.end) > toMin(p.start)) return `${DUTY_KINDS[x.kind]} «${x.title}»`;
      return null;
    }
    /* حساب مسودة التوزيع لفترة: التكليفات الأسبوعية الثابتة محسوبة أولًا (من supOn)، ثم المرافق التلقائية بترتيب المعالجة؛
       اختيارات المسودة تُحتسب أثناء توزيع بقية المرافق فلا يظهر المعلم متاحًا مرتين في الفرصة نفسها. لا يغيّر أي شيء محفوظ. */
    function rotPlan(d, sc, from, to) {
      const queues = {}; const st0 = rotState(sc); const days = [];
      for (let date = from; date <= to; date = addD(date, 1)) {
        const dk = Engine.dayKeyOf(date); const taken = {}; const rows = [];
        for (const p of placesOrdered(sc)) {
          if (p.status !== 'active') continue;
          const cfg = cfgAt(p, date); if (cfg.system !== 'rot' || !(cfg.days || []).includes(dk)) continue;
          const done = rotDays(sc).find(x => x.date === date && x.placeId === p.id);
          if (done) { rows.push({ placeId: p.id, placeName: p.name, approved: true, required: done.required, assigned: done.assigned, short: done.short, breaks: done.breaks || [] }); for (const r of rotLog(sc)) if (r.date === date && r.placeId === p.id && r.status !== 'cancelled') (taken[r.pid] = taken[r.pid] || new Set()).add(r.teacherId); continue; }
          const rb = rotBreaks(sc, cfg, date);
          const key = p.id;
          if (!queues[key] || queues[key].cfgId !== cfg.id) queues[key] = { cfgId: cfg.id, queue: queueFor(queues[key] || st0[p.id], cfg) };
          const Q = queues[key];
          if (rb.err) { rows.push({ placeId: p.id, placeName: p.name, cfgId: cfg.id, required: cfg.count, assigned: 0, short: cfg.count, err: rb.err, bell: !!rb.bell, breaks: [] }); continue; }
          const brs = [];
          for (const br of rb.list) {
            const used = taken[br.id] = taken[br.id] || new Set();
            const got = [], skipped = [];
            for (const tid of Q.queue) {
              if (got.length >= cfg.count) break;
              const why = used.has(tid) ? 'مكلّف في مرفق آخر بالفرصة نفسها (المسودة)' : unavailWhy(d, sc, tid, date, br);
              if (why) { skipped.push({ id: tid, name: tName(d, tid), why }); continue; }
              got.push(tid); used.add(tid);
            }
            // المُسنَدون إلى آخر الطابور بترتيب إسنادهم، وغير المتاحين يبقون في مكانهم
            Q.queue = Q.queue.filter(id => !got.includes(id)).concat(got);
            brs.push({ pid: br.id, name: br.name, start: br.start, end: br.end, required: cfg.count, teachers: got.map(id => ({ id, name: tName(d, id) })), short: cfg.count - got.length, skipped });
          }
          const req = cfg.count * brs.length, asg = brs.reduce((a, x) => a + x.teachers.length, 0);
          rows.push({ placeId: p.id, placeName: p.name, cfgId: cfg.id, required: req, assigned: asg, short: req - asg, breaks: brs });
        }
        if (rows.length) days.push({ date, dayName: Engine.DAY_NAMES[dk], rows });
      }
      const sig = JSON.stringify(days.map(x => [x.date, x.rows.map(r => [r.placeId, r.approved ? 'A' : r.cfgId, (r.breaks || []).map(b => [b.pid, (b.teachers || []).map(t => t.id)]), r.err || ''])]));
      let h = 2166136261; for (let i = 0; i < sig.length; i++) { h ^= sig.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
      return { days, queues, hash: 'rp' + h.toString(16) + '_' + sig.length };
    }
    const cfgView = (d, c) => c && ({ id: c.id, from: c.from, system: c.system, participants: (c.participants || []).map(id => ({ id, name: tName(d, id) })), days: c.days || [], brk: c.brk || '', start: c.start || null, count: c.count || 1, at: c.at, by: c.by });
    function cleanCfg(d, sc, sid, a, today) {
      const system = a.system === 'rot' ? 'rot' : a.system === 'weekly' ? 'weekly' : null; if (!system) fail('اختر نظام المراقبة للمرفق.');
      const from = isDate(a.from) ? a.from : today; if (from < today) fail('تاريخ سريان الإعداد لا يكون في الماضي.');
      const c = { id: uid('spc'), from, system };
      if (system === 'rot') {
        const inSchool = new Set(deptsOfSchool(d, sid).map(x => x.id));
        const ids = Array.from(new Set((Array.isArray(a.participants) ? a.participants : []).map(String))).slice(0, 200);
        if (!ids.length) fail('اختر المعلمين المشاركين في دور هذا المرفق.');
        for (const id of ids) { const t = d.teachers.find(y => y.id === id); if (!t || t.status !== 'active' || !inSchool.has(t.deptId)) fail('معلم ليس من معلمي المدرسة الفعّالين.', 'forbidden'); }
        const days = Array.from(new Set((Array.isArray(a.days) ? a.days : []).filter(k => DAY_KEYS.includes(k)))); if (!days.length) fail('اختر أيام تطبيق المراقبة.');
        const count = Number(a.count);
        if (!Number.isInteger(count) || count < 1 || count > 50) fail('عدد المراقبين المطلوبين في كل فرصة عدد صحيح موجب. لتعطيل المراقبة في المرفق استخدم «تعطيل المرفق».');
        if (count > ids.length) fail(`عدد المراقبين المطلوبين (${count}) أكبر من عدد المشاركين (${ids.length}). صحّح العدد أو أضف مشاركين.`, 'invalid');
        const brk = a.brk === '*' ? '*' : str(a.brk, 60);
        const start = a.start && ids.includes(String(a.start)) ? String(a.start) : null;
        Object.assign(c, { participants: ids, days, count, brk, start });
      }
      return c;
    }
    const vName = n => str(n, 60);
    op('sup.get', ['admin', 'head'], async (ctx, a) => {
      const d = getDb(); const sid = manageSchool(ctx, a.schoolId, 'supManage'); const sc = schoolIn(d, sid);
      const today = kuwaitToday(now()); const date = isDate(a.date) ? a.date : today;
      const v = versionAt(sc, today);
      // أيام المدرسة الدراسية وفرصها (حسب التوقيت الساري اليوم)
      const days = DAY_KEYS.map(k => { const pid = v ? (v.days || {})[k] : null; const pr = pid && pid !== 'off' ? v.profiles.find(p => p.id === pid) : null;
        return { key: k, name: Engine.DAY_NAMES[k], state: !v ? 'unset' : pid === 'off' ? 'off' : pr ? 'ok' : 'unset', breaks: pr ? pr.periods.filter(p => p.type === 'break').sort((x, y) => toMin(x.start) - toMin(y.start)).map(p => ({ id: p.id, name: p.name, start: p.start, end: p.end })) : [] }; });
      const teachers = []; for (const dep of deptsOfSchool(d, sid)) for (const t of teachersOf(d, dep.id).filter(y => y.status === 'active')) teachers.push({ id: t.id, name: t.name, deptName: dep.name });
      // قائمة يوم محدد (كجدول المراقبة الورقي): من في كل مكان، ومن غير متاح لغيابه المعتمد
      const b = bellFor(sc, date); const roster = [];
      for (const x of supList(sc).filter(y => covers(y, date, sc))) {
        const v0 = supView(d, sc, x); const rec = d.days.find(r => r.date === date && (r.absentIds || []).includes(x.teacherId));
        const br = supBreaks(b, x);
        roster.push({ ...v0, times: br.map(p => p.start + '–' + p.end), breakName: x.breakId === '*' ? 'كل فرص اليوم' : (br[0] ? br[0].name : v0.breakName), absent: !!rec, partial: !!(rec && rec.absentPeriods && rec.absentPeriods[x.teacherId]), unresolved: b.state === 'ok' && !br.length });
      }
      for (const r of rotLog(sc).filter(y => y.date === date && y.status !== 'cancelled')) {
        const t = d.teachers.find(x => x.id === r.teacherId); const dep = t ? deptIn(d, t.deptId) : null; const pl = places(sc).find(x => x.id === r.placeId);
        const p = b.state === 'ok' ? b.periods.find(q => q.id === r.pid) : null; const rec = d.days.find(z => z.date === date && (z.absentIds || []).includes(r.teacherId));
        roster.push({ id: r.id, kind: 'rot', placeId: r.placeId, placeName: pl ? pl.name : r.placeName, teacherId: r.teacherId, teacherName: t ? t.name : '—', deptName: dep ? dep.name : '', breakName: p ? p.name : r.breakName, times: p ? [p.start + '–' + p.end] : [], absent: !!rec, partial: !!(rec && rec.absentPeriods && rec.absentPeriods[r.teacherId]), unresolved: !p });
      }
      roster.forEach(r => { if (!r.kind) r.kind = 'weekly'; });
      roster.sort((p, q) => p.placeName.localeCompare(q.placeName, 'ar') || p.teacherName.localeCompare(q.teacherName, 'ar'));
      return { school: { id: sc.id, name: sc.name }, today, date, dateDay: Engine.DAY_NAMES[Engine.dayKeyOf(date)], dateState: b.state, bellSet: !!v, canBell: ctx.role === 'admin' || ctx.role === 'school' || (ctx.grants || []).some(g => g.schoolId === sid && g.perms.has('bellManage')),
        places: placesOrdered(sc).map(p => { const cur = cfgAt(p, today); const fut = (p.cfgs || []).filter(c => c.from > today).sort((x, y) => (x.from < y.from ? -1 : 1));
          const st = rotState(sc)[p.id]; const q = cur.system === 'rot' ? queueFor(st, cur) : [];
          return { id: p.id, name: p.name, status: p.status, used: supList(sc).some(x => x.placeId === p.id) || rotLog(sc).some(x => x.placeId === p.id), live: supList(sc).filter(x => x.placeId === p.id && isLive(x) && (!x.to || x.to >= today)).length,
            cfg: cfgView(d, cur), future: fut.map(c => cfgView(d, c)), history: (p.cfgs || []).length, queue: q.map(id => ({ id, name: tName(d, id) })), lastApproved: (rotDays(sc).filter(x => x.placeId === p.id).sort((x, y) => (x.date < y.date ? 1 : -1))[0] || {}).date || null }; }),
        rev: sc.supRev || 0, breakNames: Array.from(new Set(days.flatMap(x => x.breaks.map(b => b.name)))),
        assigns: supList(sc).filter(x => isLive(x) && (!x.to || x.to >= today)).map(x => supView(d, sc, x)), days, teachers, roster, issues: supIssues(d, sc) };
    });
    op('sup.placeSave', ['admin', 'head'], async (ctx, a) => tx(d => {
      const sid = manageSchool(ctx, a.schoolId, 'supManage'); const sc = schoolIn(d, sid);
      const name = vName(a.name); if (name.length < 2) fail('اكتب اسم مكان المراقبة.');
      const L = places(sc);
      if (L.some(p => p.status === 'active' && p.name === name && p.id !== a.id)) fail('هذا المكان مضاف مسبقًا.', 'conflict');
      if (a.id) {
        const p = L.find(x => x.id === a.id); if (!p) fail('المكان غير موجود.', 'not_found');
        if (p.name === name) return { id: p.id };
        const before = p.name; p.name = name; p.history = (p.history || []).concat([{ at: iso(), by: ctx.name, action: 'تعديل الاسم', from: before }]);
        audit(d, ctx, 'تعديل مكان مراقبة', `${sc.name}: «${before}» ⇐ «${name}»`, null, { schoolId: sid });
        return { id: p.id };
      }
      const p = { id: uid('spl'), name, status: 'active', order: L.reduce((m, x, i) => Math.max(m, x.order != null ? x.order : i), -1) + 1, at: iso(), by: ctx.name, history: [] };
      sc.supRev = (sc.supRev || 0) + 1;
      sc.supPlaces = L.concat([p]);
      audit(d, ctx, 'إضافة مكان مراقبة', `${sc.name}: ${name}`, null, { schoolId: sid });
      return { id: p.id };
    }));
    // ترتيب المرافق (ترتيب العرض والمعالجة في التوزيع التلقائي)، وتعطيل المرفق أو تفعيله (التكليفات والتاريخ تبقى)
    op('sup.placeMove', ['admin', 'head'], async (ctx, a) => tx(d => {
      const sid = manageSchool(ctx, a.schoolId, 'supManage'); const sc = schoolIn(d, sid);
      const L = placesOrdered(sc).filter(p => p.status !== 'archived'); const i = L.findIndex(p => p.id === a.id); if (i < 0) fail('المكان غير موجود.', 'not_found');
      const j = i + (a.dir < 0 ? -1 : 1); if (j < 0 || j >= L.length) return { ok: true };
      const tmp = L[i]; L[i] = L[j]; L[j] = tmp; L.forEach((p, k) => { p.order = k; });
      sc.supRev = (sc.supRev || 0) + 1;
      audit(d, ctx, 'ترتيب مرافق المراقبة', `${sc.name}: ${L.map(p => p.name).join(' ← ')}`, null, { schoolId: sid });
      return { ok: true };
    }));
    op('sup.placeStatus', ['admin', 'head'], async (ctx, a) => tx(d => {
      const sid = manageSchool(ctx, a.schoolId, 'supManage'); const sc = schoolIn(d, sid);
      const p = places(sc).find(x => x.id === a.id); if (!p || p.status === 'archived') fail('المكان غير موجود.', 'not_found');
      const to = a.status === 'disabled' ? 'disabled' : 'active'; if (p.status === to) return { status: to };
      p.status = to; p.history = (p.history || []).concat([{ at: iso(), by: ctx.name, action: to === 'disabled' ? 'تعطيل' : 'تفعيل' }]);
      sc.supRev = (sc.supRev || 0) + 1;
      audit(d, ctx, to === 'disabled' ? 'تعطيل مرفق مراقبة' : 'تفعيل مرفق مراقبة', `${sc.name}: ${p.name}${to === 'disabled' ? ' — لا تُطبَّق المراقبة فيه، والتكليفات والتاريخ محفوظة' : ''}`, null, { schoolId: sid });
      return { status: to };
    }));
    // إعداد نظام المرفق بتاريخ سريان؛ الإعداد السابق يبقى. التحويل من الأسبوعي يُنهي التكليفات الأسبوعية القائمة بعد تأكيد صريح فقط
    op('sup.cfgSave', ['admin', 'head'], async (ctx, a) => tx(d => {
      const sid = manageSchool(ctx, a.schoolId, 'supManage'); const sc = schoolIn(d, sid); const today = kuwaitToday(now());
      if (a.baseRev != null && a.baseRev !== (sc.supRev || 0)) fail('عدّل مستخدم آخر إعدادات المراقبة الآن. حدّث الصفحة وراجع التغييرات ثم أعد الحفظ.', 'conflict');
      const p = places(sc).find(x => x.id === a.placeId); if (!p || p.status === 'archived') fail('المكان غير موجود.', 'not_found');
      const c = cleanCfg(d, sc, sid, a, today); c.at = iso(); c.by = ctx.name;
      // توزيع معتمد بعد تاريخ السريان لا يُعدَّل بصمت
      const later = rotDays(sc).filter(x => x.placeId === p.id && x.date >= c.from);
      if (later.length) fail(`يوجد توزيع مراقبة معتمد لهذا المرفق في ${later.length} يوم من ${later.map(x => x.date).sort()[0]}؛ لا يُغيَّر بصمت. اختر تاريخ سريان بعد آخر يوم معتمد (${later.map(x => x.date).sort().pop()}).`, 'conflict');
      const live = supList(sc).filter(x => x.placeId === p.id && isLive(x) && (!x.to || x.to >= c.from));
      if (c.system === 'rot' && live.length && !a.confirmEnd) return { needConfirm: true, affected: live.map(x => ({ id: x.id, teacherName: tName(d, x.teacherId), dayName: Engine.DAY_NAMES[x.dayKey], from: x.from, to: x.to || null })) };
      if (c.system === 'rot') for (const x of live) { if (x.from >= c.from) x.status = 'removed'; else x.to = addD(c.from, -1); x.history = (x.history || []).concat([{ at: iso(), by: ctx.name, action: 'إنهاء بالتحويل إلى المراقبة بالدور من ' + c.from }]); }
      // إعداد بالتاريخ نفسه يحل محل السابق في ذلك التاريخ (يبقى في السجل)
      p.cfgs = (p.cfgs || []).map(x => (x.from === c.from && !x.replacedAt ? Object.assign({}, x, { replacedAt: iso() }) : x)).concat([c]);
      p.cfgs = p.cfgs.filter(x => !x.replacedAt).concat(p.cfgs.filter(x => x.replacedAt)).slice(-60);
      sc.supRev = (sc.supRev || 0) + 1;
      audit(d, ctx, 'إعداد نظام مراقبة', `${sc.name}: ${p.name} — ${c.system === 'rot' ? `تلقائي بالدور: ${c.participants.length} مشاركًا، ${c.count} في كل فرصة، الأيام ${c.days.map(k => Engine.DAY_NAMES[k]).join('، ')}، الفرصة ${c.brk === '*' ? 'كل الفرص' : c.brk || 'الوحيدة'}` : 'أسبوعي ثابت'} — يسري من ${c.from}${live.length && c.system === 'rot' ? ` — أُنهي ${live.length} تكليف أسبوعي` : ''}`, null, { schoolId: sid });
      return { ok: true, id: c.id, ended: c.system === 'rot' ? live.length : 0 };
    }));
    // معاينة التوزيع التلقائي: لا تحرّك مؤشرات الدور ولا تحفظ شيئًا
    op('sup.rotPreview', ['admin', 'head'], async (ctx, a) => {
      const d = getDb(); const sid = manageSchool(ctx, a.schoolId, 'supManage'); const sc = schoolIn(d, sid); const today = kuwaitToday(now());
      const from = isDate(a.from) ? a.from : today, to = isDate(a.to) ? a.to : from;
      if (from < today) fail('المعاينة والاعتماد لتاريخ اليوم أو بعده.'); if (to < from) fail('نهاية الفترة قبل بدايتها.');
      if (addD(from, 30) < to) fail('أقصى فترة للمعاينة 31 يومًا.');
      const r = rotPlan(d, sc, from, to);
      return { from, to, days: r.days, hash: r.hash, order: placesOrdered(sc).filter(p => p.status === 'active').map(p => ({ id: p.id, name: p.name, system: cfgAt(p, from).system })) };
    });
    // الاعتماد: يُعاد الحساب في الخادم ويُقارن بما عُرض؛ ثم تُحفظ التكليفات ومؤشرات الدور معًا في معاملة واحدة
    op('sup.rotApprove', ['admin', 'head'], async (ctx, a) => tx(d => {
      const sid = manageSchool(ctx, a.schoolId, 'supManage'); const sc = schoolIn(d, sid); const today = kuwaitToday(now());
      const from = isDate(a.from) ? a.from : null, to = isDate(a.to) ? a.to : null;
      if (!from || !to || from < today || to < from || addD(from, 30) < to) fail('فترة الاعتماد غير صالحة.');
      const r = rotPlan(d, sc, from, to);
      const pending = r.days.flatMap(x => x.rows.filter(y => !y.approved).map(y => ({ date: x.date, row: y })));
      if (!pending.length) return { ok: true, already: true, saved: 0 };
      if (a.hash !== r.hash) fail('تغيّرت البيانات المؤثرة في التوزيع (غياب، تكليفات، إعدادات، أو اعتماد من مستخدم آخر). أعد حساب المسودة وراجعها قبل الاعتماد.', 'conflict');
      const batch = uid('srb'); let n = 0;
      const log = rotLog(sc).slice(), dlist = rotDays(sc).slice();
      for (const { date, row } of pending) {
        if (dlist.some(x => x.date === date && x.placeId === row.placeId)) continue;
        for (const br of row.breaks) for (const t of br.teachers) {
          if (log.some(x => x.date === date && x.placeId === row.placeId && x.pid === br.pid && x.teacherId === t.id && x.status !== 'cancelled')) continue;
          log.push({ id: uid('sra'), date, placeId: row.placeId, placeName: row.placeName, pid: br.pid, breakName: br.name, start: br.start, end: br.end, teacherId: t.id, status: 'active', batch, at: iso(), by: ctx.name }); n++;
        }
        dlist.push({ date, placeId: row.placeId, cfgId: row.cfgId, required: row.required, assigned: row.assigned, short: row.short, err: row.err || null,
          breaks: row.breaks.map(b => ({ pid: b.pid, name: b.name, start: b.start, end: b.end, required: b.required, teachers: b.teachers, short: b.short, skipped: b.skipped })), batch, at: iso(), by: ctx.name });
      }
      const st = Object.assign({}, rotState(sc));
      for (const pid in r.queues) st[pid] = { cfgId: r.queues[pid].cfgId, queue: r.queues[pid].queue, at: iso(), by: ctx.name, through: to };
      sc.supRotLog = log; sc.supRotDays = dlist; sc.supRot = st; sc.supRev = (sc.supRev || 0) + 1;
      const short = pending.reduce((s0, x) => s0 + (x.row.short || 0), 0);
      audit(d, ctx, 'اعتماد توزيع المراقبة', `${sc.name}: من ${from} إلى ${to} — ${n} تكليفًا${short ? ` — غير مغطى ${short}` : ''}`, null, { schoolId: sid });
      return { ok: true, saved: n, short, batch };
    }));
    // إزالة مكان: غير المستخدم يُحذف، والمستخدم سابقًا يُؤرشف (يبقى في السجل)، والمستخدم حاليًا لا يُزال قبل إنهاء تكليفاته
    op('sup.placeRemove', ['admin', 'head'], async (ctx, a) => tx(d => {
      const sid = manageSchool(ctx, a.schoolId, 'supManage'); const sc = schoolIn(d, sid); const today = kuwaitToday(now());
      const p = places(sc).find(x => x.id === a.id); if (!p) fail('المكان غير موجود.', 'not_found');
      const live = supList(sc).filter(x => x.placeId === p.id && isLive(x) && (!x.to || x.to >= today));
      if (live.length) fail(`المكان «${p.name}» عليه ${live.length} تكليف قائم. أنهِ التكليفات أو انقلها أولًا.`, 'conflict');
      if (supList(sc).some(x => x.placeId === p.id) || rotLog(sc).some(x => x.placeId === p.id) || (p.cfgs || []).length) { p.status = 'archived'; p.history = (p.history || []).concat([{ at: iso(), by: ctx.name, action: 'أرشفة' }]); }
      else sc.supPlaces = places(sc).filter(x => x.id !== p.id);
      audit(d, ctx, 'إزالة مكان مراقبة', `${sc.name}: ${p.name}${p.status === 'archived' ? ' (أُرشف لاستخدامه سابقًا)' : ''}`, null, { schoolId: sid });
      return { archived: p.status === 'archived' };
    }));
    op('sup.assignSave', ['admin', 'head'], async (ctx, a) => tx(d => {
      const sid = manageSchool(ctx, a.schoolId, 'supManage'); const sc = schoolIn(d, sid); const today = kuwaitToday(now());
      const pl = places(sc).find(x => x.id === a.placeId && x.status === 'active'); if (!pl) fail('اختر مكان المراقبة (المرفق المعطّل لا يُضاف إليه).');
      const t = d.teachers.find(x => x.id === a.teacherId); const inSchool = new Set(deptsOfSchool(d, sid).map(x => x.id));
      if (!t || t.status !== 'active' || !inSchool.has(t.deptId)) fail('اختر معلمًا من معلمي المدرسة الفعّالين.', 'forbidden');
      const dayKey = DAY_KEYS.includes(a.dayKey) ? a.dayKey : null; if (!dayKey) fail('اختر يوم المراقبة.');
      const old = a.id ? supList(sc).find(x => x.id === a.id) : null;
      if (a.id && (!old || !isLive(old))) fail('التكليف غير موجود أو منتهٍ.', 'not_found');
      const from = isDate(a.from) ? a.from : (old && old.from <= today ? old.from : today);
      if ((!old || from !== old.from) && from < today) fail('تاريخ بدء السريان لا يكون في الماضي.');
      const to = a.to ? String(a.to) : null; if (to && (!isDate(to) || to < from)) fail('تاريخ النهاية يجب أن يكون بعد تاريخ البدء.');
      if (cfgAt(pl, from).system !== 'weekly') fail(`نظام المراقبة في «${pl.name}» تلقائي بالدور في ${from}؛ التكليف الأسبوعي الثابت يكون في المرافق ذات النظام الأسبوعي.`, 'conflict');
      const swc = (pl.cfgs || []).filter(c => c.system === 'rot' && c.from > from && (!to || c.from <= to)).sort((x, y) => (x.from < y.from ? -1 : 1))[0];
      if (swc) fail(`يتحول «${pl.name}» إلى المراقبة بالدور من ${swc.from}؛ اجعل نهاية التكليف قبل ذلك.`, 'conflict');
      // اليوم والفرصة من التوقيت الساري في أول موعد للتكليف (لا تخمين للوقت)
      let first = from; for (let i = 0; i < 7 && Engine.dayKeyOf(first) !== dayKey; i++) first = addD(first, 1);
      if (to && first > to) fail('لا يقع يوم المراقبة المختار ضمن مدة السريان.');
      const b = bellFor(sc, first);
      if (b.state === 'unset') fail(`لم يُضبط توقيت يوم ${Engine.DAY_NAMES[dayKey]} في «توقيت اليوم الدراسي»؛ لا يمكن ربط المراقبة بفرصة. اضبط التوقيت أولًا.`, 'no_bell');
      if (b.state === 'off') fail(`يوم ${Engine.DAY_NAMES[dayKey]} مسجل بلا دوام في توقيت المدرسة؛ لا يُنشأ تكليف في يوم عطلة.`, 'conflict');
      const brs = breaksOf(b);
      if (!brs.length) fail(`لا توجد فرصة مضبوطة في توقيت يوم ${Engine.DAY_NAMES[dayKey]}. أضف الفرصة في «توقيت اليوم الدراسي» أولًا.`, 'no_bell');
      let breakId = a.breakId ? String(a.breakId) : null;
      if (brs.length === 1) breakId = breakId === '*' ? '*' : brs[0].id;
      if (!breakId) fail('لليوم أكثر من فرصة؛ اختر الفرصة.');
      if (breakId !== '*' && !brs.some(p => p.id === breakId)) fail('الفرصة المختارة ليست في توقيت هذا اليوم.');
      // يوم مراقبة واحد للمعلم ضمن الفترة الفعالة (ولا مراقبتان متزامنتان)
      const overlap = x => isLive(x) && x.teacherId === t.id && x.id !== (old && old.id) && x.from <= (to || '9999-12-31') && (x.to || '9999-12-31') >= from;
      const other = supList(sc).find(overlap);
      if (other) {
        const op0 = places(sc).find(x => x.id === other.placeId);
        fail(`لدى «${t.name}» يوم مراقبة قائم: ${Engine.DAY_NAMES[other.dayKey]} — ${op0 ? op0.name : '—'} (من ${other.from}${other.to ? ' إلى ' + other.to : ''}). لكل معلم يوم مراقبة واحد في الأسبوع؛ عدّل التكليف الحالي بدل إنشاء تكليف ثانٍ.`, 'exists');
      }
      // التزام آخر مسجل في وقت المراقبة (اجتماع/التزام بتاريخ ووقت)
      for (const x of (sc.duties || []).filter(y => y.status === 'active' && y.date >= from && (!to || y.date <= to) && Engine.dayKeyOf(y.date) === dayKey && (y.teacherIds || []).includes(t.id))) {
        const bx = bellFor(sc, x.date); const br = supBreaks(bx, { breakId });
        if (br.some(p => toMin(x.start) < toMin(p.end) && toMin(x.end) > toMin(p.start))) fail(`«${t.name}» لديه ${DUTY_KINDS[x.kind]} «${x.title}» بتاريخ ${x.date} (${x.start}–${x.end}) في وقت المراقبة نفسه.`, 'conflict');
      }
      const breakName = breakId === '*' ? 'كل فرص اليوم' : brs.find(p => p.id === breakId).name;
      const snap = { placeId: pl.id, teacherId: t.id, dayKey, breakId, breakName, from, to };
      if (old) {
        const before = { placeId: old.placeId, teacherId: old.teacherId, dayKey: old.dayKey, breakId: old.breakId, breakName: old.breakName, from: old.from, to: old.to || null };
        Object.assign(old, snap); old.history = (old.history || []).concat([{ at: iso(), by: ctx.name, action: 'تعديل', before }]);
        audit(d, ctx, 'تعديل مراقبة أسبوعية', `${sc.name}: ${t.name} — ${pl.name} — ${Engine.DAY_NAMES[dayKey]} — ${breakName} — من ${from}${to ? ' إلى ' + to : ''}`, null, { schoolId: sid });
        return { id: old.id };
      }
      const x = { id: uid('sup'), ...snap, status: 'active', by: ctx.name, at: iso(), history: [{ at: iso(), by: ctx.name, action: 'إضافة' }] };
      sc.supAssigns = supList(sc).concat([x]);
      audit(d, ctx, 'إضافة مراقبة أسبوعية', `${sc.name}: ${t.name} — ${pl.name} — ${Engine.DAY_NAMES[dayKey]} — ${breakName} — من ${from}${to ? ' إلى ' + to : ''}`, null, { schoolId: sid });
      return { id: x.id };
    }));
    // إنهاء/إزالة تكليف: يبقى في السجل. لم يبدأ بعد = يُلغى، وبدأ = ينتهي أمس (فلا تظهر مراقبة اليوم)
    op('sup.assignEnd', ['admin', 'head'], async (ctx, a) => tx(d => {
      const sid = manageSchool(ctx, a.schoolId, 'supManage'); const sc = schoolIn(d, sid); const today = kuwaitToday(now());
      const x = supList(sc).find(y => y.id === a.id); if (!x || !isLive(x)) fail('التكليف غير موجود أو منتهٍ.', 'not_found');
      const t = d.teachers.find(y => y.id === x.teacherId); const pl = places(sc).find(y => y.id === x.placeId);
      if (x.from >= today) { x.status = 'removed'; } else { x.to = addD(today, -1); }
      x.history = (x.history || []).concat([{ at: iso(), by: ctx.name, action: x.status === 'removed' ? 'إزالة قبل البدء' : 'إنهاء' }]);
      audit(d, ctx, 'إنهاء مراقبة أسبوعية', `${sc.name}: ${t ? t.name : '—'} — ${pl ? pl.name : '—'} — ${Engine.DAY_NAMES[x.dayKey]}${x.status === 'removed' ? ' (لم يبدأ)' : ' — آخر يوم ' + x.to}`, null, { schoolId: sid });
      return { ok: true };
    }));

    /* الاختيار الجماعي للنظام الأسبوعي الثابت: مراقبو مرفق في يوم واحد يُحفظون دفعة واحدة (الإضافات والإلغاءات معًا).
       - يوم مراقبة واحد لكل معلم في الأسبوع عبر كل المرافق؛ المسجل في يوم أو مرفق آخر يُرفض مع اسمه وسببه، ولا يُحفظ شيء جزئيًا.
       - الفرصة من توقيت اليوم (لا إدخال وقت)؛ عند تعدد الفرص تُختار بالاسم أو «كل فرص اليوم».
       - الإلغاء: لم يبدأ = يُزال، وبدأ = ينتهي أمس (لا تتغير الأسابيع السابقة). تغيير الفرصة لتكليف بدأ = إنهاؤه وتكليف جديد من اليوم.
       - رقم مراجعة المراقبة يمنع تعارض حفظ إداريين؛ إعادة الحفظ بالمجموعة نفسها لا تغيّر شيئًا. */
    op('sup.weeklySetDay', ['admin', 'head'], async (ctx, a) => tx(d => {
      const sid = manageSchool(ctx, a.schoolId, 'supManage'); const sc = schoolIn(d, sid); const today = kuwaitToday(now());
      if (Number(a.rev) !== (sc.supRev || 0)) fail('عدّل مستخدم آخر توزيع المراقبة بعد فتح هذه الصفحة، فلم يُحفظ شيء. حدّث الصفحة وراجع التوزيع ثم احفظ.', 'conflict');
      const pl = places(sc).find(x => x.id === a.placeId && x.status === 'active'); if (!pl) fail('المرفق غير موجود أو معطّل.', 'not_found');
      if (cfgAt(pl, today).system !== 'weekly') fail(`نظام «${pl.name}» تلقائي بالدور؛ الاختيار الأسبوعي الثابت للمرافق ذات النظام الأسبوعي.`, 'conflict');
      const dayKey = DAY_KEYS.includes(a.dayKey) ? a.dayKey : null; if (!dayKey) fail('اختر اليوم الدراسي.');
      const want = Array.from(new Set((Array.isArray(a.teacherIds) ? a.teacherIds : []).map(String)));
      if (want.length > 200) fail('عدد كبير غير مسموح.');
      const inSchool = new Set(deptsOfSchool(d, sid).map(x => x.id));
      const live = x => isLive(x) && (!x.to || x.to >= today);
      const cur = supList(sc).filter(x => live(x) && x.placeId === pl.id && x.dayKey === dayKey);
      const curIds = new Set(cur.map(x => x.teacherId));
      // الفرصة: من توقيت أول موعد لليوم ابتداءً من اليوم
      let first = today; for (let i = 0; i < 7 && Engine.dayKeyOf(first) !== dayKey; i++) first = addD(first, 1);
      const b = bellFor(sc, first); const brs = breaksOf(b);
      const needBell = want.some(id => !curIds.has(id)) || a.breakId != null;
      if (needBell && want.length) {
        if (b.state === 'unset') fail(`لم يُضبط توقيت يوم ${Engine.DAY_NAMES[dayKey]} في «توقيت اليوم الدراسي»؛ لا يمكن ربط المراقبة بفرصة.`, 'no_bell');
        if (b.state === 'off') fail(`يوم ${Engine.DAY_NAMES[dayKey]} بلا دوام في توقيت المدرسة.`, 'conflict');
        if (!brs.length) fail(`لا توجد فرصة مضبوطة في توقيت يوم ${Engine.DAY_NAMES[dayKey]}.`, 'no_bell');
      }
      let breakId = a.breakId != null && a.breakId !== '' ? String(a.breakId) : null;
      if (!breakId) breakId = brs.length === 1 ? brs[0].id : (cur[0] ? cur[0].breakId : null);
      if (want.length && !breakId) fail('لليوم أكثر من فرصة؛ اختر الفرصة.');
      if (breakId && breakId !== '*' && brs.length && !brs.some(p => p.id === breakId)) fail('الفرصة المختارة ليست في توقيت هذا اليوم.');
      const breakName = breakId === '*' ? 'كل فرص اليوم' : ((brs.find(p => p.id === breakId) || {}).name || '');
      const swc = (pl.cfgs || []).filter(c => c.system === 'rot' && c.from > today).sort((x, y) => (x.from < y.from ? -1 : 1))[0];
      const to = swc ? addD(swc.from, -1) : null;
      // الفحص قبل أي تعديل: كل المشكلات معًا بأسماء أصحابها
      const problems = [];
      for (const id of want) {
        const t = d.teachers.find(x => x.id === id);
        if (!t || t.status !== 'active' || !inSchool.has(t.deptId)) { problems.push(`معلم غير موجود أو ليس من معلمي المدرسة الفعّالين.`); continue; }
        if (curIds.has(id) && !(breakId && cur.find(x => x.teacherId === id).breakId !== breakId)) continue;
        const other = supList(sc).find(x => live(x) && x.teacherId === id && !(x.placeId === pl.id && x.dayKey === dayKey));
        if (other) { const op0 = places(sc).find(x => x.id === other.placeId); problems.push(`«${t.name}» مسجل ${Engine.DAY_NAMES[other.dayKey]} — ${op0 ? op0.name : '—'} (يوم مراقبة واحد لكل معلم في الأسبوع).`); continue; }
        for (const x of (sc.duties || []).filter(y => y.status === 'active' && y.date >= today && (!to || y.date <= to) && Engine.dayKeyOf(y.date) === dayKey && (y.teacherIds || []).includes(id))) {
          const bx = bellFor(sc, x.date); const br = supBreaks(bx, { breakId });
          if (br.some(p => toMin(x.start) < toMin(p.end) && toMin(x.end) > toMin(p.start))) { problems.push(`«${t.name}» لديه ${DUTY_KINDS[x.kind]} «${x.title}» بتاريخ ${x.date} (${x.start}–${x.end}) في وقت المراقبة.`); break; }
        }
      }
      if (problems.length) fail('لم يُحفظ شيء: ' + problems.join(' '), 'conflict');
      const added = [], removed = [], changed = [];
      const endIt = (x, why) => { if (x.from >= today) x.status = 'removed'; else x.to = addD(today, -1); x.history = (x.history || []).concat([{ at: iso(), by: ctx.name, action: why }]); };
      for (const x of cur) {
        if (!want.includes(x.teacherId)) { endIt(x, x.from >= today ? 'إزالة قبل البدء' : 'إنهاء'); removed.push(tName(d, x.teacherId)); continue; }
        if (breakId && x.breakId !== breakId) {
          if (x.from >= today) { const before = { breakId: x.breakId, breakName: x.breakName }; x.breakId = breakId; x.breakName = breakName; x.history = (x.history || []).concat([{ at: iso(), by: ctx.name, action: 'تعديل', before }]); }
          else { endIt(x, 'إنهاء (تغيير الفرصة)'); sc.supAssigns = supList(sc).concat([{ id: uid('sup'), placeId: pl.id, teacherId: x.teacherId, dayKey, breakId, breakName, from: today, to: x.to && x.to >= today ? x.to : to, status: 'active', by: ctx.name, at: iso(), history: [{ at: iso(), by: ctx.name, action: 'إضافة (تغيير الفرصة)' }] }]); }
          changed.push(tName(d, x.teacherId));
        }
      }
      for (const id of want) if (!curIds.has(id)) {
        sc.supAssigns = supList(sc).concat([{ id: uid('sup'), placeId: pl.id, teacherId: id, dayKey, breakId, breakName, from: today, to, status: 'active', by: ctx.name, at: iso(), history: [{ at: iso(), by: ctx.name, action: 'إضافة' }] }]);
        added.push(tName(d, id));
      }
      if (!added.length && !removed.length && !changed.length) return { ok: true, unchanged: true, rev: sc.supRev || 0 };
      sc.supRev = (sc.supRev || 0) + 1;
      audit(d, ctx, 'حفظ مراقبي يوم (أسبوعي ثابت)', `${sc.name}: ${pl.name} — ${Engine.DAY_NAMES[dayKey]}${breakName ? ' — ' + breakName : ''}${added.length ? ' — أُضيف: ' + added.join('، ') : ''}${removed.length ? ' — أُزيل: ' + removed.join('، ') : ''}${changed.length ? ' — تغيّرت الفرصة: ' + changed.join('، ') : ''}`, null, { schoolId: sid });
      return { ok: true, added: added.length, removed: removed.length, changed: changed.length, rev: sc.supRev };
    }));

    return { bellFor, lessonStart, TYPES, dayInfo, supOn };
  }
  const BellOps = { install };
  if (typeof module !== 'undefined' && module.exports) module.exports = BellOps;
  root.BellOps = BellOps;
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* نظام الإشعارات: أنواع الأحداث المنفّذة فعلًا، وإعداداتها (تشغيل، قنوات، نصوص، مستلمون، مواعيد التذكير)
 * عامة أو مخصصة لمدرسة، واستخراج الإشعارات من الأحداث المحفوظة، والتذكيرات المجدولة.
 * - الإعدادات في بيانات النظام (meta.notifCfg) مع سجل نسخ سابقة قابلة للاستعادة (meta.notifHist). يعدّلها مدير النظام فقط.
 * - الإشعار يُنشأ من الفرق بين البيانات قبل العملية وبعدها داخل المعاملة نفسها التي حفظت الحدث، فلا إشعار لحدث لم يُحفظ،
 *   وإعادة الضغط أو إعادة المحاولة لا تنشئ فرقًا جديدًا فلا يتكرر الإشعار.
 * - القوالب نص عادي فقط: المتغيرات {اسم} من قائمة الحدث، وأي رمز تنفيذي يُرفض عند الحفظ ويُعرض كنص دائمًا.
 * - التذكيرات تُحسب عند كل نبضة جدولة من البيانات الحالية (الجدول الفعلي والتوقيت والتكليفات المعتمدة)، فتغيير التكليف
 *   أو وقته يلغي التذكير القديم تلقائيًا، والملغى لا يُذكَّر به. لا ذكاء اصطناعي أثناء التشغيل.
 */
(function (root) {
  'use strict';
  const COMMON = ['المعلم', 'القسم', 'المدرسة', 'التاريخ', 'اليوم'];
  const VARS = {
    'المعلم': 'اسم المعلم المعني', 'القسم': 'القسم', 'المدرسة': 'المدرسة', 'التاريخ': 'التاريخ', 'اليوم': 'اسم اليوم',
    'الحصة': 'رقم الحصة', 'الصف': 'الصف', 'الوقت': 'وقت البداية', 'الغائب': 'المعلم الغائب', 'المكان': 'مكان المراقبة',
    'الفرصة': 'الفرصة', 'المواعيد': 'مواعيد المراقبة', 'النظام': 'نظام المراقبة (أسبوعية/بالدور)', 'النوع': 'نوع الطلب',
    'المعلم الآخر': 'المعلم الآخر في الطلب', 'التفاصيل': 'تفاصيل الطلب', 'بواسطة': 'من نفّذ الإجراء', 'الدقائق': 'الدقائق المتبقية',
    'الحالة': 'حالة الحضور المبلّغة', 'الحالة السابقة': 'الحالة قبل التعديل', 'أول القائمة': 'أول معلم في القائمة بحالته', 'باقي القائمة': 'بقية المعلمين، سطر لكل معلم', 'القائمة': 'سطر لكل معلم بحالته (✅ حاضر، 🟡 استئذان، ❌ غائب، ⚪️ لم يسجل)', 'الحاضرون': 'أسماء من اختاروا «حاضر»', 'المستأذنون': 'المستأذنون مع وقت الوصول والحصص',
    'الغائبون': 'أسماء من اختاروا «غائب»', 'لم يسجلوا': 'أسماء من لم يسجلوا'
  };
  const SAMPLE = {
    'المعلم': 'أحمد محمد', 'القسم': 'الرياضيات', 'المدرسة': 'مدرسة تجريبية', 'التاريخ': '2026-10-20', 'اليوم': 'الثلاثاء',
    'الحصة': '3', 'الصف': '7/2', 'الوقت': '08:40', 'الغائب': 'خالد علي', 'المكان': 'المقصف', 'الفرصة': 'الفرصة الأولى',
    'المواعيد': 'كل يوم الأحد ابتداءً من 2026-10-18', 'النظام': 'أسبوعية', 'النوع': 'تبادل حصتين', 'المعلم الآخر': 'سالم أحمد',
    'التفاصيل': 'أحمد محمد (الحصة 3 — 7/2) ↔ سالم أحمد (الحصة 5 — 8/1)', 'بواسطة': 'أحمد محمد', 'الدقائق': '10',
    'الحالة': '🟡 استئذان', 'الحالة السابقة': '✅ حاضر', 'أول القائمة': 'أحمد محمد ✅ حاضر', 'باقي القائمة': 'خالد علي 🟡 استئذان (الوصول 08:30)\nسالم أحمد ❌ غائب', 'القائمة': 'أحمد محمد ✅ حاضر\nخالد علي 🟡 استئذان (الوصول 08:30)\nسالم أحمد ❌ غائب', 'الحاضرون': 'أحمد محمد، سالم أحمد', 'المستأذنون': 'خالد علي (الوصول 08:30 — الحصص 1، 2)',
    'الغائبون': 'ناصر سعد', 'لم يسجلوا': 'فهد صالح'
  };
  const RCPT = { teacher: 'المعلم المعني', head: 'رئيس القسم ونوابه', school: 'إدارة المدرسة (المدير والمساعدون)', delegate: 'المفوَّض المختص' };
  const R_DUTY = ['teacher', 'head', 'school'];
  const ALL4 = ['teacher', 'head', 'school', 'delegate'];
  const ev = (type, group, name, vars, to, def, extra) => ({ type, group, name, vars: COMMON.concat(vars), to, def, ...(extra || {}) });
  const D = (title, body, to, more) => ({ on: true, inapp: true, push: true, title, body, to, ...(more || {}) });
  const EVENTS = [
    ev('reserve.assigned', 'الاحتياط', 'إسناد حصة احتياط', ['الحصة', 'الصف', 'الوقت', 'الغائب'], R_DUTY, D('حصة احتياط', 'الأستاذ {المعلم}، لديك حصة احتياط: الحصة {الحصة} — الصف {الصف} — {اليوم} {التاريخ}.', ['teacher'])),
    ev('reserve.changed', 'الاحتياط', 'تعديل حصة احتياط', ['الحصة', 'الصف', 'الوقت', 'الغائب'], R_DUTY, D('تعديل حصة احتياط', 'عُدّلت حصة الاحتياط: الحصة {الحصة} — الصف {الصف} — {اليوم} {التاريخ}.', ['teacher'])),
    ev('reserve.cancelled', 'الاحتياط', 'إلغاء حصة احتياط', ['الحصة', 'الصف', 'الوقت', 'الغائب'], R_DUTY, D('إلغاء حصة احتياط', 'أُلغيت حصة الاحتياط: الحصة {الحصة} — الصف {الصف} — {اليوم} {التاريخ}.', ['teacher'])),
    ev('admin.referred', 'الإدارة', 'إحالة حصة إلى الإدارة', ['الحصة', 'الصف', 'الغائب'], ['head', 'school', 'delegate'], D('حصة محالة إلى الإدارة', 'أحال قسم {القسم} الحصة {الحصة} — الصف {الصف} ({اليوم} {التاريخ}) إلى الإدارة. الغائب: {الغائب}.', ['school', 'delegate'])),
    ev('admin.assigned', 'الإدارة', 'إسناد الإدارة حصة إلى معلم', ['الحصة', 'الصف', 'الوقت', 'الغائب'], ALL4, D('تكليف احتياط من الإدارة', 'الأستاذ {المعلم}، كلّفتك الإدارة بحصة احتياط: الحصة {الحصة} — الصف {الصف} — {اليوم} {التاريخ}.', ['teacher', 'head'])),
    ev('sup.assigned', 'المراقبة', 'إسناد مراقبة', ['المكان', 'الفرصة', 'الوقت', 'المواعيد', 'النظام'], ALL4, D('مراقبة', 'الأستاذ {المعلم}، لديك مراقبة {النظام}: {المكان} — {الفرصة} — {المواعيد}.', ['teacher'])),
    ev('sup.changed', 'المراقبة', 'تعديل مراقبة', ['المكان', 'الفرصة', 'الوقت', 'المواعيد', 'النظام'], ALL4, D('تعديل مراقبة', 'عُدّلت مراقبتك ({النظام}): {المكان} — {الفرصة} — {المواعيد}.', ['teacher'])),
    ev('sup.cancelled', 'المراقبة', 'إلغاء مراقبة', ['المكان', 'الفرصة', 'الوقت', 'المواعيد', 'النظام'], ALL4, D('إلغاء مراقبة', 'أُلغيت مراقبتك ({النظام}): {المكان} — {الفرصة} — {المواعيد}.', ['teacher'])),
    ev('swap.requested', 'تبديل الحصص', 'تقديم طلب تبديل حصة', ['النوع', 'المعلم الآخر', 'التفاصيل', 'بواسطة'], ALL4, D('طلب تبديل حصة', 'طلب {النوع} بتاريخ {اليوم} {التاريخ}: {التفاصيل}.', ['teacher', 'delegate'])),
    ev('swap.approved', 'تبديل الحصص', 'الموافقة على طلب تبديل', ['النوع', 'المعلم الآخر', 'التفاصيل', 'بواسطة'], ALL4, D('اعتماد طلب تبديل', 'اعتُمد طلب {النوع} بتاريخ {اليوم} {التاريخ}: {التفاصيل}.', ['teacher'])),
    ev('swap.rejected', 'تبديل الحصص', 'رفض طلب تبديل', ['النوع', 'المعلم الآخر', 'التفاصيل', 'بواسطة'], ALL4, D('رفض طلب تبديل', 'رُفض طلب {النوع} بتاريخ {اليوم} {التاريخ}: {التفاصيل}.', ['teacher'])),
    ev('swap.withdrawn', 'تبديل الحصص', 'سحب طلب تبديل', ['النوع', 'المعلم الآخر', 'التفاصيل', 'بواسطة'], ALL4, D('سحب طلب تبديل', 'سُحب طلب {النوع} بتاريخ {اليوم} {التاريخ}: {التفاصيل}.', ['teacher'])),
    // بلاغات الحضور: ملخص واحد الساعة 7:42 صباح اليوم المستهدف، ثم كل تغيير حتى 2:00 ظهرًا (لا شيء قبل الملخص ولا بعد الإغلاق)
    ev('att.summary', 'الحضور', 'ملخص بلاغات الحضور (7:42 صباحًا)', ['أول القائمة', 'باقي القائمة', 'القائمة', 'الحاضرون', 'المستأذنون', 'الغائبون', 'لم يسجلوا'], ['head'], D('✅ الحضور', '{القائمة}', ['head']), { long: true }),
    ev('att.changed', 'الحضور', 'بلاغ حضور جديد أو معدّل بعد الملخص', ['الحالة', 'الحالة السابقة', 'التفاصيل'], ['head'], D('{المعلم} {الحالة}', '{التفاصيل}', ['head'])),
    // غياب تلقائي الساعة 8:00 لمن لم يسجل حالته (عدا رئيس القسم): إشعار لصاحب السجل نفسه فقط
    ev('att.auto', 'الحضور', 'تسجيل غياب تلقائي لمن لم يسجل حالته (8:00 صباحًا)', [], ['teacher'], D('تسجيل غياب', 'تم تسجيلك غياب لعدم تسجيلك حضور ❌', ['teacher'])),
    // تذكير أعضاء القسم بالتسجيل الساعة 6:55 صباح اليوم الدراسي (يُشغَّل لكل قسم من «إعدادات الاحتياط»؛ مطفأ افتراضيًا)
    ev('att.remind', 'الحضور', 'تذكير تسجيل حالة الحضور (6:55 و7:40 صباحًا)', [], ['teacher', 'head'], D('إثبِت حضورك', 'سجّل حالتك لليوم: حاضر، استئذان صباحي، أو غائب. إذا سجلت مسبقًا، لا يلزم إجراء.', ['teacher', 'head'])),
    // تذكير بصمة التواجد: بعد تسجيل «حاضر» بساعتين ودقيقة (من 6:55 لمن سجل قبلها)، أو بعد وقت الوصول للمستأذن. يُشغَّل لكل قسم؛ مطفأ افتراضيًا
    ev('att.presence', 'الحضور', 'تذكير بصمة التواجد (بعد تسجيل الحضور)', [], ['teacher'], D('بصمة التواجد', 'لا تنسَ بصمة التواجد.', ['teacher'], { lead: 121 }), { reminder: true, after: true }),
    ev('remind.teach', 'التذكيرات', 'تذكير قبل حصة التدريس', ['الحصة', 'الصف', 'الوقت', 'الدقائق'], ['teacher'], { ...D('تذكير بحصة', 'حصتك {الحصة} — الصف {الصف} تبدأ الساعة {الوقت} (بعد {الدقائق} دقيقة).', ['teacher'], { lead: 10 }), on: false }, { reminder: true }),
    ev('remind.reserve', 'التذكيرات', 'تذكير قبل حصة الاحتياط', ['الحصة', 'الصف', 'الوقت', 'الدقائق', 'الغائب'], ['teacher'], D('تذكير بحصة احتياط', 'حصة الاحتياط {الحصة} — الصف {الصف} تبدأ الساعة {الوقت} (بعد {الدقائق} دقيقة).', ['teacher'], { lead: 10 }), { reminder: true }),
    ev('remind.sup', 'التذكيرات', 'تذكير قبل المراقبة', ['المكان', 'الفرصة', 'الوقت', 'الدقائق', 'النظام'], ['teacher'], D('تذكير بالمراقبة', 'مراقبتك في {المكان} — {الفرصة} تبدأ الساعة {الوقت} (بعد {الدقائق} دقيقة).', ['teacher'], { lead: 5 }), { reminder: true })
  ];
  const BY = Object.fromEntries(EVENTS.map(e => [e.type, e]));
  const LIM = { title: 80, body: 300 };
  const LEAD_MAX = 180;

  // ---------- القوالب ----------
  // أجزاء القالب: نص عادي و{متغير}. الأقواس غير المغلقة أو المتداخلة خطأ.
  function parse(s) {
    const out = []; let i = 0, buf = '';
    s = String(s == null ? '' : s);
    while (i < s.length) {
      const c = s[i];
      if (c === '{') {
        const j = s.indexOf('}', i + 1);
        if (j < 0) return { err: 'قوس «{» بلا إغلاق.' };
        const name = s.slice(i + 1, j);
        if (name.includes('{')) return { err: 'أقواس متداخلة.' };
        if (buf) { out.push({ t: buf }); buf = ''; }
        out.push({ v: name.trim() }); i = j + 1; continue;
      }
      if (c === '}') return { err: 'قوس «}» بلا فتح.' };
      buf += c; i++;
    }
    if (buf) out.push({ t: buf });
    return { parts: out };
  }
  // التحقق من قالب حدث: النص فقط، والمتغيرات من قائمة الحدث، وطول محدود
  function checkTemplate(type, field, s) {
    const e = BY[type]; if (!e) return 'نوع إشعار غير معروف.';
    const label = field === 'title' ? 'العنوان' : 'النص';
    s = String(s == null ? '' : s);
    if (!s.trim()) return `${label} مطلوب.`;
    if (s.length > LIM[field]) return `${label} أطول من ${LIM[field]} حرفًا.`;
    if (/[<>]/.test(s)) return `${label}: لا يُسمح بالرموز < و > (لا تُقبل أكواد داخل القوالب).`;
    if (/(javascript|data|vbscript)\s*:/i.test(s) || /&#|&[a-z]+;|\\u[0-9a-f]{4}|\$\{|`/i.test(s)) return `${label}: يحتوي رمزًا تنفيذيًا أو ترميزًا غير مسموح.`;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) return `${label}: يحتوي محارف تحكم غير مسموحة.`;
    const p = parse(s); if (p.err) return `${label}: ${p.err}`;
    const bad = p.parts.filter(x => x.v != null && !e.vars.includes(x.v)).map(x => x.v);
    if (bad.length) return `${label}: المتغير ${bad.map(x => '{' + x + '}').join('، ')} غير متاح لهذا الحدث. المتاح: ${e.vars.map(x => '{' + x + '}').join(' ')}.`;
    return null;
  }
  const clip = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  // التعبئة: نص عادي فقط (لا HTML)، والقيمة الناقصة تُكتب «—»
  function render(s, vars) {
    const p = parse(s); if (p.err) return String(s || '');
    return p.parts.map(x => (x.t != null ? x.t : (vars && vars[x.v] != null && String(vars[x.v]).trim() !== '' ? String(vars[x.v]) : '—'))).join('').replace(/\r\n?/g, '\n').replace(/\t+/g, ' ').replace(/ {2,}/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim(); // الأسطر تُحفظ (قائمة الحضور سطر لكل معلم)
  }

  // ---------- الإعدادات ----------
  const defEvent = type => { const d = BY[type].def; return { on: d.on, inapp: d.inapp, push: d.push, title: d.title, body: d.body, to: d.to.slice(), ...(BY[type].reminder ? { lead: d.lead } : {}) }; };
  const defaults = () => Object.fromEntries(EVENTS.map(e => [e.type, defEvent(e.type)]));
  // تنظيف إعداد حدث واحد (للحفظ): يعيد { value } أو { err }
  function cleanEvent(type, x) {
    const e = BY[type]; if (!e) return { err: 'نوع إشعار غير معروف: ' + type };
    if (!x || typeof x !== 'object') return { err: 'إعداد غير صالح.' };
    const v = { on: !!x.on, inapp: !!x.inapp, push: !!x.push, title: String(x.title == null ? '' : x.title).trim(), body: String(x.body == null ? '' : x.body).trim() };
    const errs = [];
    if (v.on && !v.inapp && !v.push) errs.push('اختر قناة إرسال واحدة على الأقل (داخل الموقع أو إشعار الجهاز)، أو أوقف الإشعار.');
    for (const f of ['title', 'body']) { const m = checkTemplate(type, f, v[f]); if (m) errs.push(m); }
    const to = Array.from(new Set((Array.isArray(x.to) ? x.to : []).map(String)));
    const notAllowed = to.filter(k => !e.to.includes(k));
    if (notAllowed.length) errs.push('مستلم غير متاح لهذا الحدث: ' + notAllowed.map(k => RCPT[k] || k).join('، '));
    v.to = e.to.filter(k => to.includes(k));
    if (v.on && !v.to.length) errs.push('اختر جهة مستلمة واحدة على الأقل.');
    if (e.reminder) {
      const n = Number(x.lead);
      if (!Number.isInteger(n) || n < 1 || n > LEAD_MAX) errs.push(`موعد التذكير بالدقائق: عدد صحيح من 1 إلى ${LEAD_MAX}.`);
      v.lead = n;
    }
    return errs.length ? { err: `«${e.name}»: ` + errs.join(' ') } : { value: v };
  }
  // الإعدادات المحفوظة مع قيم افتراضية لما لم يُحفظ بعد (الأنواع الجديدة تأخذ قيمها الافتراضية)
  function normCfg(raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    const g = c.global && typeof c.global === 'object' ? c.global : {};
    const global = {};
    for (const e of EVENTS) { const r = cleanEvent(e.type, g[e.type]); global[e.type] = g[e.type] && r.value ? r.value : defEvent(e.type); }
    const schools = {};
    for (const [sid, o] of Object.entries(c.schools && typeof c.schools === 'object' ? c.schools : {})) {
      const s = {}; for (const e of EVENTS) if (o && o[e.type]) { const r = cleanEvent(e.type, o[e.type]); if (r.value) s[e.type] = r.value; }
      if (Object.keys(s).length) schools[sid] = s;
    }
    return { rev: Number.isInteger(c.rev) ? c.rev : 0, global, schools, at: c.at || null, by: c.by || null };
  }
  const effective = (cfg, sid, type) => (sid && cfg.schools[sid] && cfg.schools[sid][type]) || cfg.global[type];

  // ---------- مساعدات التاريخ ----------
  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const addDays = (ds, n) => { const x = new Date(ds + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  // وقت الكويت (UTC+3 دون توقيت صيفي) إلى لحظة زمنية
  const kwAt = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+03:00`);

  function install(X) {
    const { op, tx, fail, audit, iso, deptIn, schoolIn, deptsOfSchool, Engine, kuwaitToday, now, liveGrants } = X;
    const SW = () => X.sw(), BL = () => X.bl();
    const getDb = X.db;
    const DN = k => Engine.DAY_NAMES[k] || '';
    const dayName = date => DN(Engine.dayKeyOf(date));
    const cfgOf = d => normCfg(d.meta && d.meta.notifCfg);
    const histOf = d => (d.meta && Array.isArray(d.meta.notifHist) ? d.meta.notifHist : []);
    const tOf = (d, id) => d.teachers.find(t => t.id === id) || null;
    const schoolOfDept = (d, id) => { const dep = deptIn(d, id); return dep ? dep.schoolId || null : null; };
    const activeAcc = a => a && a.status === 'active';

    // ---------- المستلمون ----------
    // حسابات المعلم: الحسابات المرتبطة بسجله (معلم/نائب/رئيس قسم مرتبط)
    const teacherAccounts = (d, tid) => d.accounts.filter(a => { const t = SW().linkedTeacherOfAcc(d, a); return t && t.id === tid; });
    const headAccounts = (d, deptId) => d.accounts.filter(a => activeAcc(a) && a.deptId === deptId && (a.kind === 'head' || a.kind === 'deputy' || !a.kind));
    const schoolAccounts = (d, sid) => d.accounts.filter(a => activeAcc(a) && (a.kind === 'principal' || a.kind === 'assistant') && a.schoolId === sid);
    // المفوَّض المختص: تفويض سارٍ في المدرسة بالصلاحية المناسبة (ونطاقه يشمل القسم إن كان الحدث لقسم)
    function delegateAccounts(d, sid, perm, deptIds) {
      if (!perm) return [];
      return d.accounts.filter(a => activeAcc(a) && (a.kind === 'head' || a.kind === 'deputy' || !a.kind) && liveGrants(d, a.id).some(g => g.schoolId === sid && g.perms.has(perm) && (!deptIds || !deptIds.length || deptIds.some(id => g.deptIds.includes(id)))));
    }
    const PERM_OF = { reserve: null, admin: 'adminDist', sup: 'supManage', swap: 'swapManage', remind: null, att: null };
    const LINK = {
      teacher: { reserve: '#/mySchedule', admin: '#/mySchedule', sup: '#/mySchedule', swap: '#/mySchedule', remind: '#/mySchedule', att: '#/home' },
      head: { reserve: '#/today', admin: '#/today', sup: '#/home', swap: '#/home', remind: '#/home', att: '#/today' },
      school: { reserve: '#/schoolToday', admin: '#/schoolAdmin', sup: '#/supervision', swap: '#/swapsAdmin', remind: '#/home', att: '#/schoolToday' },
      delegate: { reserve: '#/schoolToday', admin: '#/schoolAdmin', sup: '#/supervision', swap: '#/swapsAdmin', remind: '#/home', att: '#/schoolToday' }
    };
    /* المستلمون لحدث: من المدرسة نفسها فقط، دون تكرار الحساب، ودون منفّذ الإجراء نفسه.
       الحساب الذي يجمع أكثر من صفة يأخذ أقربها للحدث (المعلم ← رئيس القسم ← الإدارة ← المفوَّض). */
    function recipients(d, type, to, sid, teacherIds, deptIds, actorId) {
      const fam = type.split('.')[0]; const out = new Map();
      const add = (a, role) => { if (!a || a.id === actorId || out.has(a.id)) return; const dep = a.deptId ? deptIn(d, a.deptId) : null; const asid = a.schoolId || (dep && dep.schoolId) || null; if (asid !== sid) return; out.set(a.id, { accountId: a.id, role, link: LINK[role][fam] }); };
      if (to.includes('teacher')) for (const tid of teacherIds) for (const a of teacherAccounts(d, tid)) add(a, 'teacher');
      if (to.includes('head')) for (const id of deptIds) for (const a of headAccounts(d, id)) add(a, 'head');
      if (to.includes('school')) for (const a of schoolAccounts(d, sid)) add(a, 'school');
      if (to.includes('delegate')) for (const a of delegateAccounts(d, sid, PERM_OF[fam], deptIds)) add(a, 'delegate');
      // مدير النظام المربوط بسجل معلم: يصله ما يصل لذلك المعلم (تذكير الحصة والاحتياط والمراقبة والتكليفات…)
      if (to.includes('teacher') && d.admin && d.admin.teacherId && actorId !== 'admin' && !out.has('admin') && teacherIds.includes(d.admin.teacherId)) {
        const t = tOf(d, d.admin.teacherId); const dep = t ? deptIn(d, t.deptId) : null;
        if (t && t.status === 'active' && dep && dep.schoolId === sid) out.set('admin', { accountId: 'admin', role: 'teacher', link: LINK.teacher[fam] });
      }
      // الحضور: مدير النظام المربوط بسجل معلم في القسم يُعامل كعضو فيه (التذكير والملخص وإشعارات التغيير)
      if (fam === 'att' && type !== 'att.auto' && type !== 'att.presence' && d.admin && d.admin.teacherId && actorId !== 'admin' && !out.has('admin')) {
        const t = tOf(d, d.admin.teacherId); const dep = t ? deptIn(d, t.deptId) : null;
        if (t && t.status === 'active' && dep && dep.schoolId === sid && deptIds.includes(dep.id)) out.set('admin', { accountId: 'admin', role: 'head', link: LINK.head[fam] });
      }
      return [...out.values()];
    }
    // تحويل حدث إلى إشعارات لكل مستلم حسب الإعداد الساري للمدرسة
    function build(d, cfg, item, actorId, stamp) {
      const c = effective(cfg, item.schoolId, item.type);
      if (!c || !c.on || (!c.inapp && !c.push)) return [];
      let rs = recipients(d, item.type, c.to, item.schoolId, item.teacherIds || [], item.deptIds || [], actorId);
      // لا يصل صاحب البلاغ إشعار عن نفسه (مثل «❌ لم يسجل» لرئيس/نائب/مدير مربوط هو نفسه المعني)
      if (item.notSelf) { const own = new Set(teacherAccounts(d, item.notSelf).map(a => a.id)); if (d.admin && d.admin.teacherId === item.notSelf) own.add('admin'); rs = rs.filter(r => !own.has(r.accountId)); }
      return rs.map(r => {
        const vars = { ...item.vars, 'المعلم': item.vars['المعلم'] };
        return { accountId: r.accountId, role: r.role, schoolId: item.schoolId, kind: item.type, key: `${item.type}:${item.key}:${stamp}`,
          title: clip(render(c.title, vars), 120), body: clip(render(c.body, vars), BY[item.type] && BY[item.type].long ? 3000 : 500), link: r.link, inapp: !!c.inapp, push: !!c.push };
      });
    }
    const baseVars = (d, sid, tid, deptId, date) => {
      const t = tid ? tOf(d, tid) : null; const dep = deptIn(d, deptId || (t && t.deptId)); const sc = schoolIn(d, sid);
      return { 'المعلم': t ? t.name : '', 'القسم': dep ? dep.name : '', 'المدرسة': sc ? sc.name : '', 'التاريخ': date || '', 'اليوم': date ? dayName(date) : '' };
    };

    // ---------- الاحتياط: (معلم، تاريخ، حصة) ----------
    function reserveMap(d, today) {
      const m = new Map();
      for (const rec of d.days || []) {
        if (!rec || rec.date < today || rec.demo) continue;
        const dep = deptIn(d, rec.deptId); if (!dep || !dep.schoolId) continue;
        for (const s of (rec.result && rec.result.slots) || []) if (s.status === 'covered' && s.teacherId)
          m.set(`${s.teacherId}|${rec.date}|${s.period}`, { tid: s.teacherId, date: rec.date, period: s.period, cls: s.cls || '', absentName: s.absentName || '', deptId: dep.id, schoolId: dep.schoolId, src: 'dept' });
      }
      for (const e of Array.isArray(d.adminAssigns) ? d.adminAssigns : []) if (e.state === 'assigned' && e.teacherId && e.date >= today) {
        const t = tOf(d, e.teacherId);
        m.set(`${e.teacherId}|${e.date}|${e.period}`, { tid: e.teacherId, date: e.date, period: e.period, cls: e.cls || '', absentName: [e.absentName, e.srcDeptName].filter(Boolean).join(' — '), deptId: e.toDeptId || (t && t.deptId), schoolId: e.schoolId, src: 'admin', aaId: e.id });
      }
      return m;
    }
    function referralMap(d, today) {
      const m = new Map();
      for (const rec of d.days || []) {
        if (!rec || rec.date < today || rec.demo) continue;
        const dep = deptIn(d, rec.deptId); if (!dep || !dep.schoolId) continue;
        for (const s of (rec.result && rec.result.slots) || []) if (s.status === 'admin') m.set(`${rec.deptId}|${rec.date}|${s.key}`, { date: rec.date, period: s.period, cls: s.cls || '', absentName: s.absentName || '', deptId: dep.id, schoolId: dep.schoolId });
      }
      return m;
    }
    const resItem = (d, type, x) => {
      const sc = schoolIn(d, x.schoolId);
      const vars = { ...baseVars(d, x.schoolId, x.tid, x.deptId, x.date), 'الحصة': String(x.period), 'الصف': x.cls, 'الغائب': x.absentName, 'الوقت': (sc && BL().lessonStart(sc, x.date, x.period)) || '' };
      return { type, schoolId: x.schoolId, teacherIds: [x.tid], deptIds: [x.deptId], key: `${x.tid}|${x.date}|${x.period}`, vars };
    };

    // ---------- المراقبة ----------
    const placeName = (sc, id, fb) => ((Array.isArray(sc.supPlaces) ? sc.supPlaces : []).find(p => p.id === id) || {}).name || fb || '—';
    const weeklyLive = (a, today) => a && a.status === 'active' && (!a.to || a.to >= today);
    const wSnap = a => JSON.stringify([a.teacherId, a.placeId, a.dayKey, a.breakId, a.from, a.to || null]);
    // وقت فرصة التكليف الأسبوعي في أول موعد له
    function weeklyWhen(sc, a, today) {
      let dt = a.from > today ? a.from : today;
      for (let i = 0; i < 7 && Engine.dayKeyOf(dt) !== a.dayKey; i++) dt = addDays(dt, 1);
      const b = BL().bellFor(sc, dt);
      const brs = b.state === 'ok' ? b.periods.filter(p => p.type === 'break' && (a.breakId === '*' || p.id === a.breakId)) : [];
      return { date: dt, breakName: a.breakId === '*' ? 'كل فرص اليوم' : (brs[0] ? brs[0].name : a.breakName || '—'), time: brs.map(p => p.start).join('، ') };
    }
    function supItems(d0, d1, today) {
      const out = [];
      const sids = new Set((d0.schools || []).concat(d1.schools || []).map(s => s && s.id).filter(Boolean));
      for (const sid of sids) {
        const s0 = (d0.schools || []).find(x => x.id === sid) || {}, s1 = (d1.schools || []).find(x => x.id === sid) || {};
        if (JSON.stringify([s0.supAssigns || [], s0.supRotLog || []]) === JSON.stringify([s1.supAssigns || [], s1.supRotLog || []])) continue;
        const sc = s1.id ? s1 : s0;
        const tDept = tid => { const t = tOf(d1, tid) || tOf(d0, tid); return t ? t.deptId : null; };
        // الأسبوعي: لكل تكليف
        const A0 = new Map((s0.supAssigns || []).map(a => [a.id, a])), A1 = new Map((s1.supAssigns || []).map(a => [a.id, a]));
        const wItem = (type, a, scx) => {
          const w = weeklyWhen(scx, a, today);
          return { type, schoolId: sid, teacherIds: [a.teacherId], deptIds: [tDept(a.teacherId)].filter(Boolean), key: `w|${a.id}|${type}`,
            vars: { ...baseVars(d1, sid, a.teacherId, tDept(a.teacherId), w.date), 'المكان': placeName(scx, a.placeId), 'الفرصة': w.breakName, 'الوقت': w.time, 'النظام': 'أسبوعية',
              'المواعيد': `كل يوم ${DN(a.dayKey)} ${a.from > today ? 'ابتداءً من ' + a.from : ''}${a.to ? ' حتى ' + a.to : ''}`.replace(/\s+/g, ' ').trim() } };
        };
        for (const [id, a] of A1) {
          const b = A0.get(id); const live1 = weeklyLive(a, today), live0 = weeklyLive(b, today);
          if (live1 && !live0) out.push(wItem('sup.assigned', a, s1));
          else if (!live1 && live0) out.push(wItem('sup.cancelled', b, s0));
          else if (live1 && live0 && wSnap(a) !== wSnap(b)) {
            if (a.teacherId !== b.teacherId) { out.push(wItem('sup.cancelled', b, s0)); out.push(wItem('sup.assigned', a, s1)); }
            else out.push(wItem('sup.changed', a, s1));
          }
        }
        for (const [id, b] of A0) if (!A1.has(id) && weeklyLive(b, today)) out.push(wItem('sup.cancelled', b, s0));
        // بالدور: التكليفات المعتمدة الجديدة أو الملغاة، مجمّعة لكل معلم
        const L0 = new Map((s0.supRotLog || []).map(r => [r.id, r])), L1 = new Map((s1.supRotLog || []).map(r => [r.id, r]));
        const act = r => r && r.status !== 'cancelled' && r.date >= today;
        const groups = new Map();
        const put = (type, r, scx) => { const k = type + '|' + r.teacherId; if (!groups.has(k)) groups.set(k, { type, tid: r.teacherId, rows: [], sc: scx }); groups.get(k).rows.push(r); };
        for (const [id, r] of L1) { const b = L0.get(id); if (act(r) && !act(b)) put('sup.assigned', r, s1); else if (!act(r) && act(b)) put('sup.cancelled', b, s0); }
        for (const [id, b] of L0) if (!L1.has(id) && act(b)) put('sup.cancelled', b, s0);
        for (const g of groups.values()) {
          g.rows.sort((x, y) => (x.date === y.date ? (x.start < y.start ? -1 : 1) : x.date < y.date ? -1 : 1));
          const f = g.rows[0]; const places = Array.from(new Set(g.rows.map(r => placeName(g.sc, r.placeId, r.placeName))));
          out.push({ type: g.type, schoolId: sid, teacherIds: [g.tid], deptIds: [tDept(g.tid)].filter(Boolean), key: `r|${g.tid}|${g.rows.map(r => r.id).join(',')}`,
            vars: { ...baseVars(d1, sid, g.tid, tDept(g.tid), f.date), 'المكان': places.join('، '), 'الفرصة': Array.from(new Set(g.rows.map(r => r.breakName))).join('، '), 'الوقت': f.start || '', 'النظام': 'بالدور',
              'المواعيد': g.rows.slice(0, 8).map(r => `${dayName(r.date)} ${r.date}`).join('، ') + (g.rows.length > 8 ? ` و${g.rows.length - 8} أخرى` : '') } });
        }
      }
      return out;
    }

    // ---------- طلبات التبديل ----------
    const SWAP_EV = { pending: 'swap.requested', approved: 'swap.approved', rejected: 'swap.rejected', withdrawn: 'swap.withdrawn' };
    function swapItems(d0, d1, actorName) {
      const out = []; const B = new Map((d0.swaps || []).map(s => [s.id, s]));
      for (const s of d1.swaps || []) {
        const b = B.get(s.id); const was = b ? b.status : null;
        if (was === s.status) continue;
        if (s.status === 'pending' && was) continue;
        if (s.status !== 'pending' && was !== 'pending') continue;
        const type = SWAP_EV[s.status]; if (!type) continue;
        const kind = s.kind === 'swap' ? 'تبادل حصتين' : 'تغطية حصة';
        const det = s.kind === 'swap' ? `${s.a.name} (الحصة ${s.a.period} — ${s.a.cls}) ↔ ${s.b.name} (الحصة ${s.b.period} — ${s.b.cls})` : `تغطية حصة ${s.a.name} (الحصة ${s.a.period} — ${s.a.cls}) بواسطة ${s.b.name}`;
        const lastEv = Array.isArray(s.events) && s.events.length ? s.events[s.events.length - 1] : null;
        out.push({ type, schoolId: s.schoolId, teacherIds: [s.a.teacherId, s.b.teacherId], deptIds: Array.from(new Set([s.a.deptId, s.b.deptId].filter(Boolean))), key: `s|${s.id}|${s.status}`,
          vars: { ...baseVars(d1, s.schoolId, s.a.teacherId, s.a.deptId, s.date), 'النوع': kind, 'المعلم الآخر': s.b.name, 'التفاصيل': det, 'بواسطة': (lastEv && lastEv.actor) || actorName || '' } });
      }
      return out;
    }

    /* الإشعارات الناتجة عن عملية محفوظة: الفرق بين البيانات قبلها (d0) وبعدها (d1). actor: { id, name } */
    function derive(d0, d1, actor) {
      const today = kuwaitToday(now()); const cfg = cfgOf(d1); const items = [];
      const r0 = reserveMap(d0, today), r1 = reserveMap(d1, today);
      for (const [k, x] of r1) {
        const b = r0.get(k);
        if (!b) items.push(resItem(d1, x.src === 'admin' ? 'admin.assigned' : 'reserve.assigned', x));
        else if (b.cls !== x.cls || b.src !== x.src || b.absentName !== x.absentName) items.push(resItem(d1, 'reserve.changed', x));
      }
      for (const [k, b] of r0) if (!r1.has(k)) items.push(resItem(d0, 'reserve.cancelled', b));
      const f0 = referralMap(d0, today), f1 = referralMap(d1, today);
      for (const [k, x] of f1) if (!f0.has(k)) {
        const vars = { ...baseVars(d1, x.schoolId, null, x.deptId, x.date), 'الحصة': String(x.period), 'الصف': x.cls, 'الغائب': x.absentName };
        items.push({ type: 'admin.referred', schoolId: x.schoolId, teacherIds: [], deptIds: [x.deptId], key: 'ref|' + k, vars });
      }
      items.push(...supItems(d0, d1, today));
      items.push(...swapItems(d0, d1, actor && actor.name));
      items.push(...attItems(d0, d1));
      const stamp = now().getTime().toString(36);
      const out = [];
      for (const it of items) if (it.schoolId) out.push(...build(d1, cfg, it, actor && actor.id, stamp));
      return out;
    }

    // ---------- بلاغات الحضور ----------
    const AT = () => X.att();
    const attDesc = x => (x ? (AT().ATT_ST[x.status] || '') + (x.status === 'late' ? (x.arrival ? ' — الوصول ' + x.arrival : '') + (x.affected && x.affected.length ? ' — الحصص ' + x.affected.join('، ') : (x.periods && x.periods.length ? ' — الحصص ' + x.periods.join('، ') : '')) : '') : 'لم يسجل');
    const ATT_ICON = { present: '✅ حاضر', late: '🟡 استئذان', absent: '❌ غائب' };
    const attIcon = x => (x ? ATT_ICON[x.status] || (AT().ATT_ST[x.status] || '') : '⚪️ لم يسجل');
    const attLate = x => (x && x.status === 'late' ? [x.arrival ? 'الوصول ' + x.arrival : '', (x.affected && x.affected.length ? x.affected : x.periods || []).length ? 'الحصص ' + (x.affected && x.affected.length ? x.affected : x.periods).join('، ') : ''].filter(Boolean).join(' — ') : '');
    // منفّذ التعديل في نص الإشعار
    const attBy = x => { const r = x.byRole || 'self'; return r === 'self' ? ' — بواسطة المعلم نفسه' : r === 'head' ? ` — بواسطة رئيس القسم: ${x.byName || ''}` : r === 'deputy' ? ` — بواسطة نائب رئيس القسم: ${x.byName || ''}` : r === 'admin' ? ' — بواسطة مدير النظام' : ''; };
    const attSig = x => (x ? JSON.stringify([x.status, x.arrival || null, x.periods || [], x.affected || []]) : '');
    // بعد ملخص 7:42 وحتى 2:00 ظهرًا فقط: بلاغ جديد أو تعديل فعلي ← إشعار لرئيس القسم ونوابه (لا شيء قبل الملخص ولا بعد الإغلاق)
    function attItems(d0, d1) {
      if (!X.att) return [];
      const A = AT(); const nowMs = now().getTime(); const out = [];
      const prev = new Map((d0.attReports || []).map(x => [x.id, x]));
      for (const x of d1.attReports || []) {
        const b = prev.get(x.id); if (attSig(b) === attSig(x)) continue;
        if (!(nowMs >= kwAt(x.date, A.ATT.summary) && nowMs < kwAt(x.date, A.ATT.close))) continue;
        const dep = deptIn(d1, x.deptId); if (!dep || !dep.schoolId || !(A.attEnabled && A.attEnabled(dep))) continue;
        // الغياب التلقائي (8:00): إشعار لصاحب السجل بدل إشعار التغيير لرئيس القسم
        if (!b && x.auto) {
          const bv = baseVars(d1, dep.schoolId, x.teacherId, x.deptId, x.date);
          out.push({ type: 'att.auto', schoolId: dep.schoolId, teacherIds: [x.teacherId], deptIds: [x.deptId], key: `auto|${x.teacherId}|${x.date}`, vars: bv });
          // ولرئيس القسم ونوابه: «أ/ الاسم ❌ لم يسجل» لكل معلم سُجّل غائبًا تلقائيًا
          out.push({ type: 'att.changed', schoolId: dep.schoolId, teacherIds: [x.teacherId], deptIds: [x.deptId], key: `att|${x.id}|auto`, notSelf: x.teacherId,
            vars: { ...bv, 'الحالة': '❌ لم يسجل', 'الحالة السابقة': '⚪️ لم يسجل', 'التفاصيل': 'سُجّل غائبًا تلقائيًا (8:00)' } });
          continue;
        }
        const approved = (d1.days || []).some(r => r.deptId === x.deptId && r.date === x.date);
        out.push({ type: 'att.changed', schoolId: dep.schoolId, teacherIds: [x.teacherId], deptIds: [x.deptId], key: `att|${x.id}|${attSig(x)}`,
          vars: (() => { const bv = baseVars(d1, dep.schoolId, x.teacherId, x.deptId, x.date);
            // صيغة مختصرة: العنوان «أ/ الاسم ✅ حاضر»، والنص للتفاصيل المهمة فقط (وقت الوصول، الحالة السابقة، من عدّل)
            const parts = [attLate(x), b ? 'كان: ' + (b.status === x.status && attLate(b) ? attLate(b) : (b.auto && b.status === 'absent' ? '❌ لم يسجل' : attIcon(b))) : '', (x.byRole || 'self') === 'self' ? '' : attBy(x).replace(/^ — /, ''), approved ? 'بعد اعتماد اليوم — راجعه من «تعديل اليوم»' : ''].filter(Boolean);
            return { ...bv, 'الحالة': attIcon(x), 'الحالة السابقة': b ? attIcon(b) : '⚪️ لم يسجل', 'التفاصيل': parts.join(' — ') || `${bv['اليوم'] || ''} ${bv['التاريخ'] || ''}`.trim() }; })() });
      }
      return out;
    }
    // تذكير 6:55 لأعضاء الأقسام المفعّل لها: مرة واحدة لكل (حساب، قسم، تاريخ)، يوم دراسي فقط، ولا إرسال متأخر بعد التفعيل
    // تذكيران لمن لم يسجل: 6:55 ثم 7:40 (قبل ملخص 7:42)؛ لكل منهما مفتاح عدم تكرار مستقل
    const ATT_REMINDS = [['06:55', ''], ['07:40', '|2']];
    function attReminders(d, from, to) {
      if (!X.att) return [];
      const out = [];
      for (const [hm, suf] of ATT_REMINDS) out.push(...attRemindAt(d, from, to, hm, suf));
      return out;
    }
    function attRemindAt(d, from, to, ATT_REMIND, suf) {
      const A = AT(); const date = kuwaitToday(new Date(to)); const S = kwAt(date, ATT_REMIND);
      if (!(S > from && S <= to)) return [];
      const cfg = cfgOf(d); const out = [];
      for (const sc of (d.schools || []).filter(x => x && x.status === 'active')) {
        for (const dep of deptsOfSchool(d, sc.id).filter(x => x.status !== 'inactive' && x.attRemind && x.attRemind.on && A.attEnabled && A.attEnabled(x))) {
          if (dep.attRemind.since === date && String(dep.attRemind.sinceHM || '') > ATT_REMIND) continue;
          if (!A.attStudy(d, sc, dep, date)) continue;
          // التذكير لمن لم يسجل حالته لليوم فقط؛ من سجل لا يصله شيء
          const tids = d.teachers.filter(t => t.deptId === dep.id && t.status === 'active' && !A.attOf(d, t.id, date)).map(t => t.id);
          if (!tids.length) continue;
          const tidOfAcc = id => { if (id === 'admin') return d.admin && d.admin.teacherId || null; const acc = d.accounts.find(x => x.id === id); const t = acc ? SW().linkedTeacherOfAcc(d, acc) : null; return t ? t.id : null; };
          const items = build(d, cfg, { type: 'att.remind', schoolId: sc.id, teacherIds: tids, deptIds: [dep.id], key: `${date}|${dep.id}${suf}`, vars: baseVars(d, sc.id, null, dep.id, date) }, null, 'r')
            .filter(it => { const tid = tidOfAcc(it.accountId); return tid && tids.includes(tid); });
          // الضغط يفتح بطاقة حضور اليوم نفسه (أو حالته المحفوظة إن أُغلق التسجيل)
          for (const it of items) it.link = '#/home/att/' + date;
          out.push(...items);
        }
      }
      return out;
    }
    /* تذكير بصمة التواجد: لكل بلاغ «حاضر» أو «استئذان صباحي» في اليوم الدراسي، في قسم مفعّل له «تسجيل حالة الحضور» و«تذكير بصمة التواجد».
       البداية: «حاضر» ← وقت التسجيل، ولا تسبق 6:55 صباح اليوم؛ «استئذان» ← وقت الوصول (أو نهاية آخر حصة متأثرة إن حُددت الحصص فقط).
       الموعد = البداية + المدة (افتراضي 121 دقيقة). لا إرسال بعد نهاية الدوام، ومرة واحدة لكل معلم في اليوم. «غائب» لا يُذكَّر. */
    const PRESENCE_FROM = '06:55', PRESENCE_LATE_MAX = '09:40';
    function attPresence(d, from, to) {
      if (!X.att) return [];
      const A = AT(); const date = kuwaitToday(new Date(to)); const cfg = cfgOf(d); const out = [];
      const hmMs = hm => kwAt(date, hm);
      for (const sc of (d.schools || []).filter(x => x && x.status === 'active')) {
        const c = effective(cfg, sc.id, 'att.presence'); if (!c || !c.on || (!c.inapp && !c.push)) continue;
        const bell = BL().bellFor(sc, date);
        const lessons = bell.state === 'ok' ? bell.periods.filter(p => p.end) : [];
        const dayEnd = lessons.length ? hmMs(lessons.map(p => p.end).sort().pop()) : null;
        for (const dep of deptsOfSchool(d, sc.id).filter(x => x.status !== 'inactive' && x.attPresence && x.attPresence.on && A.attEnabled && A.attEnabled(x))) {
          if (!A.attStudy(d, sc, dep, date)) continue;
          for (const x of (d.attReports || []).filter(r => r.deptId === dep.id && r.date === date && (r.status === 'present' || r.status === 'late'))) {
            const t = d.teachers.find(y => y.id === x.teacherId); if (!t || t.status !== 'active') continue;
            let base = null;
            if (x.status === 'present') base = Math.max(Date.parse(x.at), hmMs(PRESENCE_FROM));
            else if (x.arrival) base = hmMs(x.arrival);
            else if ((x.affected || x.periods || []).length && lessons.length) {
              const ps = (x.affected && x.affected.length ? x.affected : x.periods); const last = Math.max(...ps);
              const L = bell.periods.find(p => p.type === 'lesson' && p.lessonNo === last); if (L && L.end) base = hmMs(L.end);
            }
            if (base == null || isNaN(base)) continue;
            // المستأذن الواصل بعد 9:40 لا تلزمه بصمة تواجد، فلا تذكير
            if (x.status === 'late' && base > hmMs(PRESENCE_LATE_MAX)) continue;
            const at = base + c.lead * 60000;
            if (!(at > from && at <= to)) continue;
            if (dayEnd != null && at > dayEnd) continue;
            const items = build(d, cfg, { type: 'att.presence', schoolId: sc.id, teacherIds: [t.id], deptIds: [dep.id], key: `${date}|${t.id}`, vars: baseVars(d, sc.id, t.id, dep.id, date) }, null, 'r');
            out.push(...items);
          }
        }
      }
      return out;
    }
    // ملخص 7:42 لكل قسم في يومه الدراسي: مرة واحدة (مفتاح التاريخ والقسم)
    function attSummaries(d, from, to) {
      if (!X.att) return [];
      const A = AT(); const date = kuwaitToday(new Date(to)); const S = kwAt(date, A.ATT.summary);
      if (!(S > from && S <= to)) return [];
      const cfg = cfgOf(d); const out = [];
      for (const sc of (d.schools || []).filter(x => x && x.status === 'active')) {
        const c = effective(cfg, sc.id, 'att.summary'); if (!c || !c.on || (!c.inapp && !c.push)) continue;
        for (const dep of deptsOfSchool(d, sc.id).filter(x => x.status !== 'inactive' && A.attEnabled && A.attEnabled(x))) {
          if (!A.attStudy(d, sc, dep, date)) continue;
          const ts = d.teachers.filter(t => t.deptId === dep.id && t.status === 'active');
          if (!ts.length) continue;
          const g = { present: [], late: [], absent: [], none: [] }; const rows = { present: [], late: [], absent: [], none: [] };
          for (const t of ts) { const x0 = A.attOf(d, t.id, date); rows[x0 ? x0.status : 'none'].push(`${t.name} ${x0 ? attIcon(x0) : '⚪️ لم يسجل'}${x0 && x0.status === 'late' && attLate(x0) ? ' (' + attLate(x0) + ')' : ''}`); }
          // سطر لكل معلم: «أ/ الاسم ✅ حاضر»، مرتبة: الحاضرون ثم المستأذنون ثم الغائبون ثم من لم يسجل
          const lines = [].concat(rows.present, rows.late, rows.absent, rows.none);
          for (const t of ts) { const x = A.attOf(d, t.id, date); if (!x) g.none.push(t.name); else if (x.status === 'late') g.late.push(`${t.name} (${attDesc(x).replace(/^استئذان صباحي — /, '')})`); else g[x.status].push(t.name); }
          const L = a => (a.length ? a.join('، ') : 'لا أحد');
          out.push(...build(d, cfg, { type: 'att.summary', schoolId: sc.id, teacherIds: [], deptIds: [dep.id], key: `${date}|${dep.id}`,
            vars: { ...baseVars(d, sc.id, null, dep.id, date), 'القائمة': lines.join('\n') || 'لا أحد', 'أول القائمة': lines[0] || 'لا أحد', 'باقي القائمة': lines.slice(1).join('\n') || 'لا يوجد غيره', 'الحاضرون': L(g.present), 'المستأذنون': L(g.late), 'الغائبون': L(g.absent), 'لم يسجلوا': L(g.none) } }, null, 'r'));
        }
      }
      return out;
    }

    /* التذكيرات المستحقة في نافذة (from, to] (لحظات زمنية): ما يبدأ بعد «to» ويحين موعد تذكيره داخل النافذة.
       مفتاح التذكير يتضمن التاريخ والمعلم والحصة/الفرصة ووقت البداية: تغيّر الوقت = تذكير جديد، والملغى لا يُذكَّر به. */
    function reminders(d, from, to) {
      const date = kuwaitToday(new Date(to)); const cfg = cfgOf(d); const out = attSummaries(d, from, to).concat(attReminders(d, from, to), attPresence(d, from, to));
      for (const sc of (d.schools || []).filter(x => x && x.status === 'active')) {
        const conf = type => { const c = effective(cfg, sc.id, type); return c && c.on && (c.inapp || c.push) && c.to.includes('teacher') ? c : null; };
        const cT = conf('remind.teach'), cR = conf('remind.reserve'), cS = conf('remind.sup');
        if (!cT && !cR && !cS) continue;
        if (BL().bellFor(sc, date).state !== 'ok') continue;
        const due = (c, start) => { if (!start) return false; const S = kwAt(date, start); const at = S - c.lead * 60000; return at > from && at <= to && S > to; };
        const push = (type, c, tid, deptId, key, vars) => {
          const item = { type, schoolId: sc.id, teacherIds: [tid], deptIds: [deptId], key, vars: { ...baseVars(d, sc.id, tid, deptId, date), ...vars, 'الدقائق': String(c.lead) } };
          out.push(...build(d, cfg, item, null, 'r'));
        };
        const deps = deptsOfSchool(d, sc.id).filter(x => x.status !== 'inactive');
        const covered = reserveMap(d, date);
        for (const dep of deps) {
          const rec = (d.days || []).find(x => x.deptId === dep.id && x.date === date) || null;
          const absent = new Set(rec ? rec.absentIds || [] : []); const absP = rec ? rec.absentPeriods || {} : {};
          const isAbsent = (tid, p) => absent.has(tid) && (!absP[tid] || !absP[tid].length || absP[tid].includes(p));
          const teachers = d.teachers.filter(t => t.deptId === dep.id && t.status === 'active');
          if (cT) {
            const sch = SW().effAt(d, dep, date); const dk = Engine.dayKeyOf(date);
            for (const e of sch ? sch.entries || [] : []) if (e.day === dk && e.type === 'teach' && teachers.some(t => t.id === e.teacherId) && !isAbsent(e.teacherId, e.period)) {
              const st = BL().lessonStart(sc, date, e.period);
              if (due(cT, st)) push('remind.teach', cT, e.teacherId, dep.id, `${date}|${e.teacherId}|${e.period}|${st}`, { 'الحصة': String(e.period), 'الصف': e.cls != null ? String(e.cls) : '', 'الوقت': st });
            }
          }
          if (cS) for (const t of teachers) for (const s of BL().supOn(sc, t.id, date)) for (const br of s.breaks) if (due(cS, br.start))
            push('remind.sup', cS, t.id, dep.id, `${date}|${t.id}|${s.id}|${br.id}|${br.start}`, { 'المكان': s.place, 'الفرصة': br.name, 'الوقت': br.start, 'النظام': s.kind === 'rot' ? 'بالدور' : 'أسبوعية' });
        }
        if (cR) for (const x of covered.values()) if (x.schoolId === sc.id && x.date === date) {
          const st = BL().lessonStart(sc, date, x.period);
          if (due(cR, st)) push('remind.reserve', cR, x.tid, x.deptId, `${date}|${x.tid}|${x.period}|${st}`, { 'الحصة': String(x.period), 'الصف': x.cls, 'الوقت': st, 'الغائب': x.absentName });
        }
      }
      return out;
    }
    // هل في الإعدادات تذكير مفعّل في أي مدرسة؟ (لتخطي حساب النبضة إن لم يكن)
    function anyReminder(d) {
      const cfg = cfgOf(d);
      return (d.schools || []).some(sc => sc && sc.status === 'active' && ['remind.teach', 'remind.reserve', 'remind.sup', 'att.summary', 'att.remind', 'att.presence'].some(t => { const c = effective(cfg, sc.id, t); return c && c.on && (c.inapp || c.push); }));
    }

    // ---------- عمليات لوحة «إدارة الإشعارات» (مدير النظام فقط) ----------
    const view = d => {
      const cfg = cfgOf(d);
      return {
        events: EVENTS.map(e => ({ type: e.type, group: e.group, name: e.name, vars: e.vars, to: e.to, reminder: !!e.reminder, after: !!e.after, def: defEvent(e.type) })),
        vars: VARS, sample: SAMPLE, recipients: RCPT, limits: { ...LIM, leadMax: LEAD_MAX },
        cfg, schools: (d.schools || []).map(s => ({ id: s.id, name: s.name, status: s.status })),
        hist: histOf(d).slice().reverse().map(h => ({ rev: h.rev, at: h.at, by: h.by, note: h.note || '' }))
      };
    };
    const checkRev = (d, a) => { if (Number(a.baseRev) !== cfgOf(d).rev) fail('عُدّلت إعدادات الإشعارات من جلسة أخرى بعد فتح هذه الصفحة، فلم يُحفظ شيء. حدّث الصفحة وراجع التعديلات ثم احفظ.', 'conflict'); };
    function store(d, ctx, next, note) {
      d.meta = d.meta || {};
      const prev = cfgOf(d);
      const hist = histOf(d).concat([{ rev: prev.rev, at: prev.at || iso(), by: prev.by || 'الإعداد الافتراضي', note: note || '', cfg: { global: prev.global, schools: prev.schools } }]).slice(-15);
      d.meta.notifCfg = { rev: prev.rev + 1, global: next.global, schools: next.schools, at: iso(), by: ctx.name };
      d.meta.notifHist = hist;
      audit(d, ctx, 'تعديل إعدادات الإشعارات', note || '', null);
    }
    op('notifCfg.get', ['admin'], async () => view(getDb()));
    op('notifCfg.save', ['admin'], async (ctx, a) => tx(d => {
      checkRev(d, a);
      const cur = cfgOf(d); const scope = a.scope === 'global' || !a.scope ? 'global' : String(a.scope);
      const evs = a.events && typeof a.events === 'object' ? a.events : {};
      const errs = []; const clean = {};
      for (const [type, x] of Object.entries(evs)) { const r = cleanEvent(type, x); if (r.err) errs.push(r.err); else clean[type] = r.value; }
      if (errs.length) fail(errs.join(' | '), 'invalid');
      const next = { global: { ...cur.global }, schools: structuredClone(cur.schools) };
      let note;
      if (scope === 'global') { Object.assign(next.global, clean); note = `الإعداد العام: ${Object.keys(clean).map(t => BY[t].name).join('، ') || '—'}`; }
      else {
        const sc = schoolIn(d, scope); if (!sc) fail('المدرسة غير موجودة.', 'not_found');
        const o = { ...(next.schools[scope] || {}), ...clean };
        for (const t of Array.isArray(a.clear) ? a.clear : []) delete o[t];
        if (Object.keys(o).length) next.schools[scope] = o; else delete next.schools[scope];
        note = `تخصيص ${sc.name}: ${Object.keys(clean).map(t => BY[t].name).join('، ') || '—'}${(a.clear || []).length ? ` (إلغاء تخصيص: ${(a.clear || []).filter(t => BY[t]).map(t => BY[t].name).join('، ')})` : ''}`;
      }
      store(d, ctx, next, note);
      return view(d);
    }));
    op('notifCfg.restore', ['admin'], async (ctx, a) => tx(d => {
      checkRev(d, a);
      const h = histOf(d).find(x => x.rev === Number(a.rev)); if (!h) fail('النسخة المطلوبة غير موجودة في السجل.', 'not_found');
      const c = normCfg({ global: h.cfg.global, schools: h.cfg.schools });
      store(d, ctx, { global: c.global, schools: c.schools }, `استعادة النسخة ${h.rev} (${h.at})`);
      return view(d);
    }));
    op('notifCfg.reset', ['admin'], async (ctx, a) => tx(d => {
      checkRev(d, a);
      if (a.confirm !== true) fail('أكّد استعادة الإعدادات الافتراضية.', 'invalid');
      const cur = cfgOf(d); const scope = a.scope === 'global' || !a.scope ? 'global' : String(a.scope);
      const next = { global: cur.global, schools: structuredClone(cur.schools) };
      if (scope === 'global') next.global = defaults();
      else { if (!schoolIn(d, scope)) fail('المدرسة غير موجودة.', 'not_found'); delete next.schools[scope]; }
      store(d, ctx, next, scope === 'global' ? 'استعادة الإعدادات الافتراضية العامة' : `إلغاء كل تخصيصات ${schoolIn(d, scope).name}`);
      return view(d);
    }));
    // رسالة الاختبار: القالب الساري للحدث بقيم تجريبية (الإرسال نفسه في طبقة الحفظ لحساب المدير وأجهزته فقط)
    op('notifCfg.testPlan', ['admin'], async (ctx, a) => {
      const d = getDb(); const type = String(a.type || ''); if (!BY[type]) fail('نوع إشعار غير معروف.', 'invalid');
      const c = a.title != null || a.body != null ? { title: a.title, body: a.body } : effective(cfgOf(d), a.schoolId || null, type);
      for (const f of ['title', 'body']) { const m = checkTemplate(type, f, c[f]); if (m) fail(m, 'invalid'); }
      return { type, title: '[اختبار] ' + render(c.title, SAMPLE), body: render(c.body, SAMPLE), link: '#/notifs' };
    });

    return { derive, reminders, anyReminder, cfgOf };
  }

  const Notify = { install, EVENTS, VARS, SAMPLE, RCPT, LIM, LEAD_MAX, checkTemplate, render, parse, cleanEvent, normCfg, defaults, effective };
  if (typeof module !== 'undefined' && module.exports) module.exports = Notify;
  root.Notify = Notify;
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* خادم محاكاة — طبقة الحسابات والصلاحيات والبيانات والاعتماد.
 * يعمل داخل المتصفح في هذه النسخة، ويحفظ في التخزين المحلي للمتصفح فقط.
 * صُمّم بحيث تنتقل الدوال نفسها لاحقًا إلى خادم حقيقي وقاعدة بيانات:
 * كل عملية تمرّ عبر call(token, op, args) وتُفحص صلاحيتها هنا، لا في الواجهة.
 */
(function (root) {
  'use strict';
  const Engine = root.Engine || (typeof require !== 'undefined' ? require('./engine.js') : null);
  const TTOps = root.TTOps || (typeof require !== 'undefined' ? require('./timetable-ops.js') : null);
  const SwapOps = root.SwapOps || (typeof require !== 'undefined' ? require('./swaps.js') : null);
  const BellOps = root.BellOps || (typeof require !== 'undefined' ? require('./bell.js') : null);
  const Notify = root.Notify || (typeof require !== 'undefined' ? require('./notify.js') : null);
  const subtle = root.crypto.subtle;
  const enc = new TextEncoder();

  const SESSION_HOURS = 8;
  const REMEMBER_DAYS = 365;
  const RENEW_BELOW_DAYS = 330; // جلسة «تذكّرني» يبقى لها أقل من هذا: تُمدَّد سنة من الآن عند فتح البرنامج
  const CODE_HOURS = 48;
  // حسابات مستوى المدرسة: مدير المدرسة ومساعد المدير (صلاحيات متطابقة داخل مدرستهما)
  const SCHOOL_KINDS = ['principal', 'assistant'];
  const KIND_NAMES = { head: 'رئيس قسم', deputy: 'نائب رئيس قسم', principal: 'مدير المدرسة', assistant: 'مساعد المدير', teacher: 'معلم' };
  // نوع الحساب كما يُعرض: حسابات المعلمين نوع مستقل لا يرث صلاحيات رئيس القسم
  const kindOf = a => (SCHOOL_KINDS.includes(a.kind) ? a.kind : a.kind === 'deputy' ? 'deputy' : a.kind === 'teacher' ? 'teacher' : 'head');
  /* صلاحيات التفويض: كل صلاحية مرتبطة بعمليات موجودة فعلًا في الخادم. «يتطلب» = تبعية تُفرض عند الحفظ.
     الاطلاع منفصل عن التعديل. لا تُمنح أي صلاحية تلقائيًا. */
  const PERMS = [
    { key: 'view', group: 'المعلمون والجداول', label: 'عرض المعلمين والجداول', desc: 'الاطلاع على معلمي القسم وأرقامهم والجدول المعتمد وإصداراته، دون تعديل.', kind: 'view' },
    { key: 'teachers', group: 'المعلمون والجداول', label: 'إدارة بيانات المعلمين', desc: 'إضافة معلم، تعديل الاسم ورقم الواتساب، الأرشفة، الإدخال في الدور أو الإخراج منه، وترتيبهم. (تعيين رئيس القسم يبقى للإدارة.)', kind: 'edit', needs: ['view'] },
    { key: 'teacherImport', group: 'المعلمون والجداول', label: 'استيراد حسابات المعلمين من Excel', desc: 'إنشاء حسابات «معلم» لمعلمي أقسام التفويض من ملف Excel (للمعلمين المسجلين في القسم فقط؛ لا يُنشأ معلم غير مسجل)، وتسجيل أرقام هواتفهم بعد المراجعة، وبدء تفعيل الحسابات الجديدة. لا يشمل إعادة تعيين كلمات المرور ولا إدارة الأدوار.', kind: 'edit' },
    { key: 'schedule', group: 'المعلمون والجداول', label: 'إدارة جدول قسم موجود', desc: 'استيراد جدول القسم من Excel ومراجعة الفروقات واعتماد إصدار جديد. لا يمس الدين ولا الدور ولا الأيام المعتمدة.', kind: 'edit', needs: ['view'] },
    { key: 'draft', group: 'الغياب والتوزيع', label: 'تسجيل الغياب وإعداد مسودة التوزيع', desc: 'تحديد الغائبين وحساب مسودة الاحتياط ومعاينتها. في هذا البرنامج يُسجَّل الغياب مع التوزيع؛ ولا يُحفظ شيء حتى الاعتماد.', kind: 'edit' },
    { key: 'approve', group: 'الغياب والتوزيع', label: 'اعتماد التوزيع وتصحيحه', desc: 'اعتماد اليوم وحفظه، وتعديل غياب يوم معتمد وتصحيح تكليفاته.', kind: 'edit', needs: ['draft'] },
    { key: 'debt', group: 'الدين والدور', label: 'تعديل الدين', desc: 'زيادة دين معلم أو إنقاصه يدويًا (عند تفعيل جدول الدين في القسم).', kind: 'edit' },
    { key: 'rotation', group: 'الدين والدور', label: 'إدارة الدور والتجاوزات', desc: 'ترتيب الدور وبدؤه والتخطي والدور المحدد يدويًا، والتجاوزات المؤقتة.', kind: 'edit' },
    { key: 'reset', group: 'الدين والدور', label: 'إعادة ضبط الدين والدور', desc: 'إعادة الضبط الشاملة أو للجزء المفعّل، مع نسخة احتياطية وإمكانية التراجع.', kind: 'edit', needs: ['debt', 'rotation'] },
    { key: 'logReset', group: 'السجل', label: 'إعادة ضبط السجل', desc: 'مسح الأيام المعتمدة من السجل الفعّال مع نسخة احتياطية.', kind: 'edit', needs: ['reports'] },
    { key: 'settings', group: 'الإعدادات', label: 'تعديل إعدادات الاحتياط', desc: 'صفحة «طريقة إدارة حصص الاحتياط»: الدين، الدور، حصة واحدة لكل معلم يوميًا. (لا تشمل سياسة التحويل للإدارة.)', kind: 'edit' },
    { key: 'deptCap', group: 'الإعدادات', label: 'إدارة حدود احتياط الأقسام', desc: 'سياسة التحويل للإدارة: السماح بالتحويل، وعدد الحصص التي يتحملها القسم قبل التحويل، وأقصى عدد يُحوَّل يوميًا، للأقسام المشمولة بالتفويض.', kind: 'edit' },
    { key: 'reports', group: 'السجل والتقارير', label: 'عرض السجلات والتقارير', desc: 'الأيام المعتمدة وتقارير القسم والمدرسة وسجل التغييرات، للاطلاع.', kind: 'view' },
    { key: 'print', group: 'السجل والتقارير', label: 'النسخ والطباعة', desc: 'نسخ رسالة القسم وعرض الطباعة. يتطلب الاطلاع على السجلات.', kind: 'view', needs: ['reports'] },
    { key: 'adminSlots', group: 'متابعة المدرسة', label: 'متابعة الحصص المحالة إلى الإدارة', desc: 'قائمة الحصص المحالة إلى الإدارة في أقسام النطاق، للاطلاع.', kind: 'view' },
    { key: 'adminDist', group: 'متابعة المدرسة', label: 'توزيع الحصص المحالة للإدارة', desc: 'إسناد الحصص المحالة إلى الإدارة لأقسام المدرسة ومعلميها (يدويًا أو بالدور بين الأقسام)، وإلغاؤه، وتسجيل تنفيذه، ودور الأقسام. على مستوى المدرسة كلها.', kind: 'edit', schoolWide: true },
    // جدول المدرسة: أداة على مستوى المدرسة، فلا تُمنح إلا بنطاق «المدرسة كلها»
    { key: 'ttView', group: 'جدول المدرسة', label: 'عرض جدول المدرسة', desc: 'فتح «جدول المدرسة» ومسودته وإصداراته للاطلاع، دون تعديل.', kind: 'view', schoolWide: true },
    { key: 'ttDraft', group: 'جدول المدرسة', label: 'إنشاء وتعديل مسودة الجدول', desc: 'تعديل المسودة (نقل وتبديل الحصص، طلبات التعديل، القواعد والإعدادات، حفظ نسخة). لا يمس جدول الاحتياط المعتمد.', kind: 'edit', needs: ['ttView'], schoolWide: true },
    { key: 'ttGenerate', group: 'جدول المدرسة', label: 'توليد الجدول', desc: 'تشغيل «إنشاء الجدول المدرسي» واعتماد المقترح في المسودة.', kind: 'edit', needs: ['ttDraft'], schoolWide: true },
    { key: 'ttApprove', group: 'جدول المدرسة', label: 'اعتماد الجدول وتفعيله للاحتياط', desc: 'تفعيل المسودة بعد الفحص بتاريخ سريان، فتصبح جدول الأقسام في الاحتياط من ذلك التاريخ.', kind: 'edit', needs: ['ttView'], schoolWide: true },
    { key: 'bellManage', group: 'جدول المدرسة', label: 'إدارة توقيت المدرسة', desc: 'إضافة فترات اليوم الدراسي وتعديلها وترتيبها (الطابور والحصص والفرص) وتوزيعها على الأيام بتاريخ سريان. لا يمس الجداول ولا أرقام الحصص.', kind: 'edit', schoolWide: true },
    { key: 'dutyManage', group: 'جدول المدرسة', label: 'إدارة الاجتماعات والالتزامات', desc: 'تسجيل الاجتماعات والالتزامات بتاريخ ووقت لمعلمي المدرسة وإلغاؤها. تظهر للمعلم في تاريخها فقط. (المراقبة لها صلاحية «إدارة المراقبة».)', kind: 'edit', schoolWide: true },
    { key: 'supManage', group: 'جدول المدرسة', label: 'إدارة المراقبة', desc: 'مرافق المراقبة وترتيبها وتعطيلها، ونظام كل مرفق (أسبوعي ثابت أو تلقائي بالدور)، وتوزيع المعلمين في الفرص ومعاينة التوزيع التلقائي واعتماده. لا يمس الجداول ولا الدين ولا دور الاحتياط.', kind: 'edit', schoolWide: true },
    { key: 'swapManage', group: 'جدول المدرسة', label: 'إدارة طلبات تبديل الحصص', desc: 'الاطلاع على طلبات تبديل الحصص المؤقتة في المدرسة والموافقة عليها أو رفضها، وإلغاء تبديل معتمد بعد فحص آثاره. لا يشمل تعديل الجدول الأساسي.', kind: 'edit', schoolWide: true },
    { key: 'ttPrint', group: 'جدول المدرسة', label: 'طباعة جدول المدرسة وتصديره', desc: 'الطباعة والتصدير (PDF وExcel والصور والنسخة الاحتياطية).', kind: 'view', needs: ['ttView'], schoolWide: true }
  ];
  const PERM_KEYS = PERMS.map(x => x.key);
  // العمليات المسموحة بكل صلاحية مفوّضة. ANY: تكفي أي صلاحية في القسم (بيانات أساسية لازمة لكل وظيفة). all: يلزم كل ما في القائمة
  const ANY = '*';
  const OP_PERMS = {
    'dept.get': ANY, 'teacher.list': ANY, 'state.get': ANY,
    'schedule.get': ['view', 'schedule'],
    'teacher.create': ['teachers'], 'teacher.update': ['teachers'], 'teacher.move': ['teachers'], 'teacher.setWhatsapp': ['teachers'], 'teacher.setWhatsappBulk': ['teachers'],
    'schedule.approveImport': ['schedule'], 'importProfile.get': ['schedule'], 'importProfile.save': ['schedule'],
    'day.get': ['draft', 'approve', 'reports'], 'day.preview': ['draft'], 'day.approve': ['approve'], 'att.list': ['draft', 'approve', 'reports'],
    'day.correctInfo': ['approve'], 'day.correctPreview': ['approve'], 'day.correct': ['approve'],
    'debt.adjust': ['debt'], 'credit.adjust': ['rotation'], 'balance.adjust': ['debt'],
    'rotation.setManualNext': ['rotation'], 'rotation.setOrder': ['rotation'], 'rotation.setStart': ['rotation'], 'rotation.skip': ['rotation'], 'rotation.unskip': ['rotation'],
    'exclusion.toggle': ['rotation'], 'exclusion.note': ['rotation'], 'exclusion.add': ['rotation'], 'exclusion.cancel': ['rotation'],
    'state.undo': { all: ['debt', 'rotation'] },
    'rotation.reset': ['reset'], 'log.reset': ['logReset'],
    'dept.settingsSave': ['settings'], 'dept.capSave': ['deptCap'], 'dept.schedSourceSave': ['schedule'], 'timetable.deptStatus': ['view', 'schedule'],
    'days.list': ['reports'], 'report.build': ['reports'], 'audit.list': ['reports'],
    'school.dashboard': ['reports', 'draft', 'adminSlots', 'adminDist'], 'school.adminSlots': ['adminSlots'], 'school.report': ['reports'],
    'adminDist.list': ['adminDist'], 'adminDist.options': ['adminDist'], 'adminDist.assign': ['adminDist'], 'adminDist.directOptions': ['adminDist'], 'adminDist.direct': ['adminDist'], 'adminDist.cancel': ['adminDist'], 'adminDist.exec': ['adminDist'],
    'adminDist.uncoverable': ['adminDist'], 'adminDist.reopen': ['adminDist'], 'adminDist.renotify': ['adminDist'], 'adminDist.autoPlan': ['adminDist'], 'adminDist.autoApply': ['adminDist'], 'adminDist.rotSave': ['adminDist']
  };
  const permAllows = (perms, op) => {
    const need = OP_PERMS[op]; if (!need) return false;
    if (need === ANY) return perms.size > 0;
    if (Array.isArray(need)) return need.some(k => perms.has(k));
    return need.all.every(k => perms.has(k));
  };
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const PBKDF2_ITER = 120000;

  class ApiError extends Error { constructor(msg, code = 'bad_request') { super(msg); this.code = code; } }
  const fail = (m, c) => { throw new ApiError(m, c); };

  // ---------- أدوات التشفير ----------
  const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  const randHex = n => { const a = new Uint8Array(n); root.crypto.getRandomValues(a); return hex(a); };
  const uid = p => p + '_' + randHex(8);
  async function sha256(s) { return hex(await subtle.digest('SHA-256', enc.encode(s))); }
  // PBKDF2-HMAC-SHA256 من WebCrypto (مكتبة المنصة القياسية، لا تشفير مبتكر). عدد التكرارات يُحفظ مع كل كلمة مرور
  async function hashPassword(pw, saltHex, iter) {
    const salt = saltHex || randHex(16);
    const n = iter || PBKDF2_ITER;
    const key = await subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: n }, key, 256);
    return { salt, hash: hex(bits), algo: 'PBKDF2-SHA256', iter: n };
  }
  // مقارنة بزمن ثابت لنصوص hex متساوية الطول
  function safeEq(a, b) {
    a = String(a || ''); b = String(b || '');
    let r = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return r === 0;
  }
  async function verifyPassword(pw, rec) {
    const h = await hashPassword(String(pw || ''), rec.salt, rec.iter || 120000);
    return safeEq(h.hash, rec.hash);
  }
  function makeCode() {
    const a = new Uint8Array(8); root.crypto.getRandomValues(a);
    const s = Array.from(a, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    return s.slice(0, 4) + '-' + s.slice(4);
  }
  const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  // ---------- التحقق ----------
  function cleanCivil(v) {
    const s = String(v == null ? '' : v).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\s/g, '');
    if (!/^\d{12}$/.test(s)) fail('الرقم المدني يجب أن يتكون من 12 رقمًا.');
    return s; // نص دائمًا
  }
  function cleanName(v, label = 'الاسم') {
    const s = String(v || '').replace(/\s+/g, ' ').trim();
    if (s.length < 2) fail(`${label} مطلوب.`);
    if (s.length > 80) fail(`${label} أطول من المسموح.`);
    return s;
  }
  function checkPassword(pw) {
    if (typeof pw !== 'string' || pw.length < 8) fail('كلمة المرور يجب ألا تقل عن 8 أحرف.');
    if (pw.length > 128) fail('كلمة المرور أطول من المسموح.');
  }
  // رقم الواتساب: رقم كويتي محلي من 8 أرقام (يُضاف 965 عند الإرسال). فارغ = حذف الرقم
  function cleanWa(v) {
    if (v == null) return null;
    // تُحذف المسافات والرموز المعتادة فقط؛ أي حرف آخر يجعل الرقم غير صالح
    const d = String(v).replace(/[٠-٩]/g, x => '٠١٢٣٤٥٦٧٨٩'.indexOf(x)).replace(/[\s+\-().\u200e\u200f]/g, '');
    if (!d) return null;
    if (/\D/.test(d)) fail('رقم الواتساب يجب أن يكون 8 أرقام بالضبط (رقم كويتي دون 965).');
    if (!/^\d{8}$/.test(d)) fail('رقم الواتساب يجب أن يكون 8 أرقام بالضبط (رقم كويتي دون 965).');
    return d;
  }
  const maskCivil = c => (c ? '••••••••' + c.slice(-4) : '');

  function kuwaitToday(now) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuwait', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  }

  const SCHEMA = 15;
  function emptyDb() {
    return {
      schema: SCHEMA,
      meta: { systemName: 'نظام إدارة حصص الاحتياط', createdAt: null },
      admin: null,
      departments: [], teachers: [], accounts: [], sessions: [], days: [], audit: [], throttle: {}, schools: [], delegations: [], timetables: [], adminAssigns: [], swaps: [], attReports: []
    };
  }

  /* ترحيل بيانات النسخة الأولى: الجدول اليدوي (عدد حصص ثابت) يتحول إلى جدول منظم بإصدار */
  function migrate(d) {
    if (d && !Array.isArray(d.attReports)) d.attReports = []; // بلاغات الحضور (تبدأ فارغة)
    if ((d.schema || 1) >= SCHEMA) return d;
    if ((d.schema || 1) >= 14) return migrate15(d);
    if ((d.schema || 1) >= 13) return migrate14(d);
    if ((d.schema || 1) >= 12) return migrate13(d);
    if ((d.schema || 1) >= 11) return migrate12(d);
    if ((d.schema || 1) >= 10) return migrate11(d);
    if ((d.schema || 1) >= 9) return migrate10(d);
    if ((d.schema || 1) >= 8) return migrate9(d);
    if ((d.schema || 1) >= 7) return migrate8(d);
    if ((d.schema || 1) >= 6) return migrate7(d);
    if ((d.schema || 1) >= 5) return migrate6(d);
    if ((d.schema || 1) >= 4) return migrate5(d);
    if ((d.schema || 1) >= 3) return migrate4(d);
    if ((d.schema || 1) >= 2) return migrate3(d);
    for (const dep of d.departments || []) {
      const ap = dep.scheduleApproved;
      dep.scheduleVersions = [];
      if (ap && Array.isArray(ap.entries)) {
        const days = (dep.studyDays || []).slice();
        const periodsByDay = {};
        for (const k of days) periodsByDay[k] = Array.from({ length: dep.periodsCount || 0 }, (_, i) => i + 1);
        const teacherIds = (d.teachers || []).filter(t => t.deptId === dep.id && t.status === 'active').map(t => t.id);
        dep.scheduleApproved = { version: ap.version, approvedAt: ap.approvedAt, approvedBy: ap.approvedBy, days, periodsByDay, teacherIds, entries: ap.entries, source: { kind: 'manual-v1', note: 'جدول أُدخل يدويًا في النسخة الأولى' } };
        dep.scheduleVersions.push(dep.scheduleApproved);
      } else dep.scheduleApproved = null;
      delete dep.scheduleDraft; delete dep.scheduleDirty; delete dep.periodsCount; delete dep.studyDays;
      dep.importProfile = null;
    }
    d.schema = 2;
    return migrate3(d);
  }
  /* النسخة 3: نائب رئيس القسم، الحقوق المعلقة، التخطي، التجاوزات المؤقتة */
  function migrate3(d) {
    for (const dep of d.departments || []) {
      dep.state = { pending: [], skips: [], pendingSeq: 0, ...dep.state };
      dep.exclusions = dep.exclusions || [];
      if (dep.deputyTeacherId === undefined) dep.deputyTeacherId = null;
    }
    for (const a of d.accounts || []) if (!a.kind) a.kind = 'head';
    d.schema = 3;
    return migrate4(d);
  }
  /* النسخة 4: الدور المحدد يدويًا + النسخ الاحتياطية للتعديلات اليدوية */
  function migrate4(d) {
    for (const dep of d.departments || []) {
      if (dep.state.manualNext === undefined) dep.state.manualNext = null;
      dep.backups = dep.backups || [];
    }
    d.schema = 4;
    return migrate5(d);
  }
  /* النسخة 5: قائمة نواب بدل نائب واحد؛ يُحفظ النائب الحالي ويُربط حسابه إن أمكن دون لبس */
  function migrate5(d) {
    for (const dep of d.departments || []) {
      if (!Array.isArray(dep.deputyTeacherIds)) dep.deputyTeacherIds = dep.deputyTeacherId ? [dep.deputyTeacherId] : [];
      delete dep.deputyTeacherId;
      const unlinked = (d.accounts || []).filter(a => a.deptId === dep.id && a.kind === 'deputy' && !a.teacherId);
      if (dep.deputyTeacherIds.length === 1 && unlinked.length === 1) unlinked[0].teacherId = dep.deputyTeacherIds[0];
    }
    d.schema = 5;
    return migrate6(d);
  }
  /* النسخة 6: حقبة الدين والدور — إعادة الضبط تبدأ دورة جديدة لا تعود إليها آثار الأيام السابقة لها */
  function migrate6(d) {
    for (const dep of d.departments || []) {
      if (dep.state.epoch != null) continue;
      const resets = (dep.backups || []).filter(b => b.action === 'إعادة ضبط الدين والدور' && !b.undone);
      const last = resets[resets.length - 1];
      dep.state.epoch = last ? 1 : 0;
      if (last) {
        dep.state.resetAt = last.at; dep.state.resetBy = last.actor;
        for (const rec of d.days || []) if (rec.deptId === dep.id && rec.approvedAt > last.at) rec.epoch = 1;
      }
    }
    d.schema = 6;
    return migrate7(d);
  }
  /* النسخة 7: سجل حركات الأيام الممسوحة (clearedLedger) بدل منع التواريخ الممسوحة.
     يُبنى من النسخ الاحتياطية لعمليات «إعادة ضبط سجل الغياب» غير المتراجع عنها؛ وتبقى النسخ نفسها كما هي. */
  function migrate7(d) {
    for (const dep of d.departments || []) {
      if (Array.isArray(dep.clearedLedger)) continue;
      const ledger = {};
      for (const b of dep.backups || []) {
        if (b.action !== 'إعادة ضبط سجل الغياب' || b.undone || !b.snapshot || !Array.isArray(b.snapshot.clearedDays)) continue;
        const cut = /إعادة الدور/.test(b.description || '');
        for (const rec of b.snapshot.clearedDays) ledger[rec.date] = { date: rec.date, epoch: rec.epoch || 0, rotationCut: cut || !!rec.rotationCut, record: structuredClone(rec), clearedAt: b.at, clearedBy: b.actor };
      }
      // تاريخ ممسوح أُعيد تسجيله بعد المسح: حركاته صارت في السجل الفعّال
      for (const rec of d.days || []) if (rec.deptId === dep.id) delete ledger[rec.date];
      dep.clearedLedger = Object.values(ledger).sort((x, y) => (x.date < y.date ? -1 : 1));
      delete dep.logClearedUpTo;
    }
    d.schema = 7;
    return migrate8(d);
  }
  /* النسخة 8: دفتر حركات الدين (debtJournal) لكل قسم من الآن فصاعدًا، لحساب أرصدة بداية ونهاية أي فترة بدقة.
     البيانات الأقدم لا تُختلق: يُحفظ آخر تاريخ حركة قديمة (legacyMaxDate)، ولا تُحسب أرصدة فترة تسبقها حركات غير مسجلة في الدفتر. */
  const DEBT_ACTIONS = ['تعديل دين يدوي', 'إعادة ضبط الدين والدور', 'تراجع عن آخر تعديل', 'تصحيح غياب يوم معتمد', 'اعتماد الحالة الافتتاحية', 'اعتماد يوم', 'إعادة تسجيل يوم مُسح سجله'];
  function migrate8(d) {
    for (const dep of d.departments || []) {
      if (Array.isArray(dep.debtJournal)) continue;
      const dates = [];
      for (const rec of d.days || []) if (rec.deptId === dep.id) dates.push(rec.date, kuwaitToday(new Date(rec.approvedAt)));
      for (const e of dep.clearedLedger || []) dates.push(e.date);
      for (const b of dep.backups || []) for (const rec of (b.snapshot && b.snapshot.clearedDays) || []) dates.push(rec.date);
      for (const a of d.audit || []) if (a.deptId === dep.id && DEBT_ACTIONS.includes(a.action)) dates.push(kuwaitToday(new Date(a.at)));
      dep.debtJournal = [];
      dep.legacyMaxDate = dates.filter(Boolean).sort().pop() || null;
    }
    d.schema = 8;
    return migrate9(d);
  }
  /* النسخة 9: بداية دفتر الحركات (journalSince) لفحص الأرصدة بعد إعادة الضبط */
  function migrate9(d) {
    for (const dep of d.departments || []) {
      if (dep.journalSince) continue;
      const first = (dep.debtJournal || [])[0];
      dep.journalSince = first ? first.at : new Date().toISOString();
    }
    d.schema = 9;
    return migrate10(d);
  }
  /* النسخة 10: الجلسات تُحفظ ببصمة الرمز لا بالرمز نفسه (الجلسات القديمة تُلغى)، وسجل محاولات الدخول */
  function migrate10(d) {
    d.sessions = (d.sessions || []).filter(s => s.tokenHash);
    if (!d.throttle || typeof d.throttle !== 'object') d.throttle = {};
    d.schema = 10;
    return migrate11(d);
  }
  /* النسخة 11: مستوى المدرسة. الأقسام القائمة تبقى «غير مرتبطة بمدرسة» حتى يربطها مدير النظام صراحة (لا تخمين) */
  function migrate11(d) {
    if (!Array.isArray(d.schools)) d.schools = [];
    d.schema = 11;
    return migrate12(d);
  }
  /* النسخة 12: التفويضات (لا يُمنح شيء تلقائيًا) */
  function migrate12(d) {
    if (!Array.isArray(d.delegations)) d.delegations = [];
    d.schema = 12;
    return migrate13(d);
  }
  /* النسخة 13: جدول المدرسة (إعدادات ومسودة وإصدارات لكل مدرسة). لا تُنقل بيانات تجريبية؛ يبدأ فارغًا */
  function migrate13(d) {
    if (!Array.isArray(d.timetables)) d.timetables = [];
    d.schema = 13;
    return migrate14(d);
  }
  /* النسخة 14: تكليفات الإدارة للحصص المحالة إليها (تبدأ فارغة) */
  function migrate14(d) {
    if (!Array.isArray(d.adminAssigns)) d.adminAssigns = [];
    d.schema = 14;
    return migrate15(d);
  }
  /* النسخة 15: طلبات تبديل الحصص المؤقتة (تبدأ فارغة؛ لا تمس الجداول الأساسية) */
  function migrate15(d) {
    if (!Array.isArray(d.swaps)) d.swaps = [];
    d.schema = SCHEMA;
    return d;
  }

  const MAX_ENTRIES = 6000;
  // تبديلات حصص بين معلمَين: أزواج مفاتيح حصص [k1, k2]
  function cleanSwaps(w) {
    if (!Array.isArray(w)) return [];
    return w.filter(p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string' && p[0] !== p[1]).slice(0, 60).map(p => [p[0].slice(0, 200), p[1].slice(0, 200)]);
  }
  function cleanManual(m) {
    const out = {};
    for (const [k, v] of Object.entries(m || {})) {
      if (!v || typeof v !== 'object' || typeof v.teacherId !== 'string') continue;
      out[String(k).slice(0, 200)] = { teacherId: v.teacherId, source: v.source === 'debt' ? 'debt' : 'rotation', reason: String(v.reason || '').slice(0, 300) };
    }
    return out;
  }
  function validateSchedulePayload(p, teacherIdsOfDept) {
    if (!p || typeof p !== 'object') fail('بيانات الجدول غير صالحة.');
    const days = Array.isArray(p.days) ? p.days : [];
    if (!days.length || days.some(k => !Engine.DAY_KEYS.includes(k)) || new Set(days).size !== days.length) fail('أيام الجدول غير صالحة.');
    const pbd = {};
    for (const k of days) {
      const arr = (p.periodsByDay || {})[k];
      if (!Array.isArray(arr) || !arr.length || arr.some(n => !Number.isInteger(n) || n < 1 || n > 20) || new Set(arr).size !== arr.length) fail(`أرقام حصص يوم ${Engine.DAY_NAMES[k]} غير صالحة.`);
      pbd[k] = arr.slice().sort((a, b) => a - b);
    }
    const tids = Array.isArray(p.teacherIds) ? p.teacherIds : [];
    if (!tids.length) fail('لا يوجد معلمون مرتبطون في الجدول.');
    if (new Set(tids).size !== tids.length) fail('معلم مكرر في الجدول.');
    for (const t of tids) if (!teacherIdsOfDept.has(t)) fail('الجدول يحتوي معلمًا ليس من هذا القسم.', 'forbidden');
    const ents = Array.isArray(p.entries) ? p.entries : [];
    if (ents.length > MAX_ENTRIES) fail('عدد خانات الجدول أكبر من المسموح.');
    const seen = new Set(); const tset = new Set(tids); const out = [];
    for (const e of ents) {
      if (!tset.has(e.teacherId)) fail('خانة لمعلم غير مرتبط في الجدول.');
      if (!days.includes(e.day) || !pbd[e.day].includes(e.period)) fail('خانة بيوم أو رقم حصة خارج بنية الجدول.');
      if (!Engine.SLOT_TYPES[e.type]) fail('نوع خانة غير معروف.');
      const cls = String(e.cls || '').trim().slice(0, 30);
      if (e.type === 'teach' && !cls) fail('حصة تدريس دون صف.');
      const k = e.teacherId + '|' + e.day + '|' + e.period;
      if (seen.has(k)) fail('تعارض: خانتان للمعلم نفسه في الحصة نفسها.');
      seen.add(k);
      out.push({ teacherId: e.teacherId, day: e.day, period: e.period, type: e.type, cls: e.type === 'teach' ? cls : '', raw: String(e.raw || '').slice(0, 120), ref: String(e.ref || '').slice(0, 80) });
    }
    return { days: Engine.DAY_KEYS.filter(k => days.includes(k)), periodsByDay: pbd, teacherIds: tids.slice(), entries: out };
  }

  function createServer(opts) {
    const storage = opts.storage; // {load():string|null, save(string)}
    const now = opts.now || (() => new Date());
    const latency = opts.latency || 0;
    // نسخة الإنتاج: إعداد المدير بمفتاح سري من إعدادات الخادم فقط، ولا بيانات تجريبية ولا حذف شامل
    const production = !!opts.production;
    const setupKey = opts.setupKey || null;
    const pwIter = opts.pbkdf2Iter || PBKDF2_ITER;
    let db;
    let persistent = true;
    // آخر نص محفوظ قرأه هذا الخادم أو كتبه. أي اختلاف عنه يعني أن جلسة/نافذة أخرى حفظت بعده.
    let lastRaw = null;
    try { const raw = storage.load(); lastRaw = raw; db = raw ? JSON.parse(raw) : emptyDb(); } catch (e) { db = emptyDb(); persistent = false; }
    db = migrate(db);

    // قبل كل عملية: إعادة القراءة من مصدر الحفظ الفعلي إذا تغيّر، فلا تعمل نافذة قديمة على نسخة قديمة في الذاكرة
    function sync() {
      if (!persistent) return;
      let raw; try { raw = storage.load(); } catch (e) { return; }
      if (raw != null && raw !== lastRaw) { db = migrate(JSON.parse(raw)); lastRaw = raw; }
    }
    function commit(next) {
      if (persistent) {
        // حماية من الكتابة فوق حفظ أحدث: إن حفظت جلسة أخرى أثناء العملية تُرفض ولا يُكتب شيء
        let rawNow = null; try { rawNow = storage.load(); } catch (e) { rawNow = lastRaw; }
        if (rawNow != null && rawNow !== lastRaw) {
          sync();
          throw new ApiError('تغيّرت بيانات الموقع من نافذة أو جلسة أخرى أثناء العملية، فلم يُحفظ شيء حتى لا تُكتب حالة قديمة فوقها. حُدّثت البيانات؛ راجعها ثم أعد المحاولة.', 'conflict');
        }
      }
      const raw = JSON.stringify(next);
      try { storage.save(raw); } catch (e) {
        if (persistent) throw new ApiError('تعذّر الحفظ في هذا المتصفح. لم يُحفظ أي تغيير.', 'save_failed');
      }
      lastRaw = raw;
      db = next;
    }
    // معاملة ذرية: التعديل على نسخة، ثم استبدال كامل عند النجاح فقط
    async function tx(fn) {
      const draft = structuredClone(db);
      const out = await fn(draft);
      commit(draft);
      return out;
    }
    const iso = () => now().toISOString();
    function audit(d, ctx, action, details, deptId, extra) {
      const via = ctx && ctx.usedGrant ? { delegationId: ctx.usedGrant.id, onBehalfOf: ctx.usedGrant.grantorName } : {};
      d.audit.push({ id: uid('log'), at: iso(), actor: ctx ? ctx.name + (ctx.usedGrant ? ` (بتفويض من ${ctx.usedGrant.grantorName})` : '') : 'النظام', role: ctx ? (ctx.role === 'admin' ? 'admin' : ctx.kind || 'head') : null, action, deptId: deptId || null, details: details || '', ...via, ...(extra || {}) });
    }
    // أي تغيير يؤثر في التوزيع يرفع إصدار حالة القسم، فتُعتبر المسودات السابقة بحاجة لإعادة الحساب
    // changeId: معرّف النسخة الاحتياطية للتعديل اليدوي، أو معرّف عام لأي تغيير آخر (يمنع التراجع فوقه)
    function bump(dep, changeId) {
      dep.state.version = (dep.state.version || 0) + 1;
      dep.state.lastChangeId = arguments.length > 1 ? changeId : 'chg_' + randHex(6);
      const b = changeId ? (dep.backups || []).find(x => x.id === changeId) : null;
      if (b && b.versionAfter == null) b.versionAfter = dep.state.version;
    }
    // دفتر حركات الدين: سطر لكل معلم تغيّر رصيده، بتاريخ الحركة (تاريخ اليوم الدراسي للتوزيع والتصحيح، وتاريخ التنفيذ لغيرهما)
    function journal(dep, ctx, kind, beforeDebts, afterDebts, eventDate, ref) {
      if (!Array.isArray(dep.debtJournal)) dep.debtJournal = [];
      const ids = new Set(Object.keys(beforeDebts || {}).concat(Object.keys(afterDebts || {})));
      for (const id of ids) {
        const b0 = Math.max(0, (beforeDebts || {})[id] || 0), a0 = Math.max(0, (afterDebts || {})[id] || 0);
        if (b0 === a0) continue;
        dep.debtJournal.push({ id: uid('jr'), at: iso(), date: eventDate || kuwaitToday(now()), kind, teacherId: id, before: b0, after: a0, delta: a0 - b0, ref: ref || null, actor: ctx ? ctx.name : null });
      }
    }
    const requireVersion = (dep, v) => { if (v !== dep.state.version) fail('تغيّرت حالة القسم منذ فتح هذه الصفحة (تعديل آخر أو توزيع معتمد). حدّث الصفحة ثم أعد المحاولة.', 'conflict'); };

    // ---------- الجلسة والنطاق ----------
    function resolve(token) {
      if (!token) return null;
      const s = db.sessions.find(x => x.tokenHash === token);
      if (!s || new Date(s.expiresAt) < now()) return null;
      if (s.role === 'admin') return db.admin ? { role: 'admin', id: 'admin', name: db.admin.name } : null;
      return accountCtx(s.accountId);
    }
    // سياق الحساب من بياناته المحفوظة (يُستخدم للجلسة، ولمعاينة مدير النظام لحساب آخر دون جلسة لذلك الحساب)
    // pv: معاينة مدير النظام فقط — تسمح بمعاينة حساب معلم لم يُفعَّل بعد (للقراءة على نسخة مؤقتة، دون دخول فعلي)
    function accountCtx(accountId, pv) {
      const a = db.accounts.find(x => x.id === accountId);
      if (!a || !(a.status === 'active' || (pv && a.kind === 'teacher' && a.status === 'pending'))) return null;
      if (a.kind === 'deputy' && a.teacherId) { const dep = db.departments.find(x => x.id === a.deptId); if (!dep || !(dep.deputyTeacherIds || []).includes(a.teacherId)) return null; }
      // حساب المعلم: يرى جدوله وتكليفاته فقط. مرتبط بسجل معلم فعّال في قسم فعّال ومدرسة فعّالة (من البيانات المحفوظة)
      if (a.kind === 'teacher') {
        const t = db.teachers.find(x => x.id === a.teacherId); if (!t || t.status !== 'active') return null;
        const dep = db.departments.find(x => x.id === t.deptId); if (!dep || dep.status === 'inactive') return null;
        const sc = dep.schoolId ? (db.schools || []).find(x => x.id === dep.schoolId) : null;
        if (dep.schoolId && (!sc || sc.status !== 'active')) return null;
        return { role: 'teacher', kind: 'teacher', id: a.id, name: a.name, teacherId: t.id, deptId: t.deptId, schoolId: dep.schoolId || null };
      }
      // مدير المدرسة ومساعده: نطاقهما مدرستهما فقط (المدرسة يجب أن تكون موجودة وفعّالة)
      if (SCHOOL_KINDS.includes(a.kind)) {
        const sc = (db.schools || []).find(x => x.id === a.schoolId);
        if (!sc || sc.status !== 'active') return null;
        return { role: 'school', kind: a.kind, id: a.id, name: a.name, schoolId: sc.id };
      }
      // صلاحية الحساب (رئيس القسم أو نائبه) مستقلة عن الإعفاء من الاحتياط. التفويضات السارية تُضاف إليها ولا تغيّرها
      return { role: 'head', kind: a.kind === 'deputy' ? 'deputy' : 'head', id: a.id, name: a.name, deptId: a.deptId, grants: liveGrants(db, a.id) };
    }
    // ---------- التفويض ----------
    // حالة التفويض الآن: سارٍ فقط إذا كان مفعّلًا وضمن مدته، والمدرسة فعّالة، والمانح ما زال مدير/مساعد هذه المدرسة (أو المنظّم)، والمفوَّض حساب فعّال في المدرسة
    function delegationState(d, g, today) {
      if (g.status === 'revoked') return 'revoked';
      if (g.status === 'suspended') return 'suspended';
      const sc = schoolIn(d, g.schoolId);
      if (!sc || sc.status !== 'active') return 'suspended';
      if (g.grantorId !== 'admin') {
        const gr = d.accounts.find(x => x.id === g.grantorId);
        if (!gr || gr.status !== 'active' || !SCHOOL_KINDS.includes(gr.kind) || gr.schoolId !== g.schoolId) return 'suspended';
      }
      const ge = d.accounts.find(x => x.id === g.granteeId);
      const gd = ge ? deptIn(d, ge.deptId) : null;
      if (!ge || ge.status !== 'active' || !gd || gd.schoolId !== g.schoolId) return 'inactive';
      if (g.startDate > today) return 'scheduled';
      if (g.endDate && g.endDate < today) return 'expired';
      return 'active';
    }
    function liveGrants(d, accountId) {
      const today = kuwaitToday(now());
      return (d.delegations || []).filter(g => g.granteeId === accountId && delegationState(d, g, today) === 'active').map(g => ({
        id: g.id, schoolId: g.schoolId, perms: new Set(g.perms.filter(k => PERM_KEYS.includes(k))), grantorName: g.grantorName, allDepts: !!g.allDepts,
        deptIds: (g.allDepts ? deptsOfSchool(d, g.schoolId).map(x => x.id) : g.deptIds.filter(id => { const x = deptIn(d, id); return x && x.schoolId === g.schoolId; }))
      }));
    }
    // التفويضات التي تسمح بعملية على قسم محدد (أو على أي قسم إذا لم يُحدد)
    const grantFor = (ctx, op, deptId) => (ctx.grants || []).find(g => (deptId == null || g.deptIds.includes(deptId)) && permAllows(g.perms, op)) || null;
    const permsIn = (ctx, deptId) => { const out = new Set(); for (const g of ctx.grants || []) if (g.deptIds.includes(deptId)) for (const k of g.perms) out.add(k); return out; };
    // الأقسام التي يصل إليها الحساب بعملية معينة (للعمليات على مستوى المدرسة)
    function deptsFor(ctx, sid, op) {
      if (ctx.role === 'admin' || ctx.role === 'school') return deptsOfSchool(db, sid).map(x => x.id);
      const ids = new Set(); for (const g of ctx.grants || []) if (g.schoolId === sid && permAllows(g.perms, op)) for (const id of g.deptIds) ids.add(id);
      return Array.from(ids);
    }
    /* القسم المسموح: المدير يمرر القسم ويُتحقق من وجوده؛ رئيس القسم يُحدد قسمه من حسابه في الخادم،
       وأي معرّف قسم مختلف يرسله المتصفح يُرفض. */
    function scope(ctx, deptId) {
      if (ctx.role === 'admin') {
        const d = db.departments.find(x => x.id === deptId);
        if (!d) fail('القسم غير موجود.', 'not_found');
        return d.id;
      }
      // مدير المدرسة ومساعده: القسم يجب أن يكون من مدرستهما حسب البيانات المحفوظة (لا يُوثق بمعرّف المتصفح وحده)
      if (ctx.role === 'school') {
        const d = db.departments.find(x => x.id === deptId);
        if (!d || d.schoolId !== ctx.schoolId) fail('غير مصرح لك بالوصول إلى هذا القسم.', 'forbidden');
        return d.id;
      }
      // رئيس القسم ونائبه: قسمهم بصلاحياتهم الأصلية؛ وغيره (أو عملية ليست من صلاحياتهم الأصلية) فقط بتفويض سارٍ يشمل القسم والعملية
      const target = deptId || ctx.deptId;
      if (target === ctx.deptId && !ctx.viaGrant) return ctx.deptId;
      const g = grantFor(ctx, ctx.op, target);
      if (!g || !db.departments.some(x => x.id === target)) fail('غير مصرح لك بالوصول إلى هذا القسم.', 'forbidden');
      ctx.usedGrant = g;
      return target;
    }
    const deptIn = (d, id) => d.departments.find(x => x.id === id);
    const schoolIn = (d, id) => (d.schools || []).find(x => x.id === id) || null;
    // المدرسة المسموحة: المدير يمرر المدرسة؛ مدير المدرسة ومساعده مدرستهما من الحساب، وأي معرّف آخر يُرفض
    function schoolScope(ctx, schoolId) {
      if (ctx.role === 'school') { if (schoolId && schoolId !== ctx.schoolId) fail('غير مصرح لك بالوصول إلى هذه المدرسة.', 'forbidden'); return ctx.schoolId; }
      if (ctx.role === 'admin') { if (!schoolIn(db, schoolId)) fail('المدرسة غير موجودة.', 'not_found'); return schoolId; }
      if (ctx.role === 'head') { const g = grantFor(ctx, ctx.op, null); if (g && (!schoolId || schoolId === g.schoolId)) return g.schoolId; }
      fail('غير مصرح لك بالوصول إلى بيانات المدرسة.', 'forbidden');
    }
    const deptsOfSchool = (d, schoolId) => d.departments.filter(x => x.schoolId === schoolId);
    const teachersOf = (d, deptId) => d.teachers.filter(t => t.deptId === deptId);
    // طريقة إدارة حصص الاحتياط لكل قسم. القسم القائم بلا إعدادات = السلوك السابق: الدين مفعّل، الدور مفعّل، الإحالة للإدارة مطفأة
    const settingsOf = dep => {
      const x = dep.settings || {};
      return { debt: x.debt !== false, rotation: x.rotation !== false, adminTransfer: x.adminTransfer === true, oneDaily: x.oneDaily === true, ...capOf(x) };
    };
    /* قيم التحويل للإدارة لكل قسم: cap = عدد الحصص التي يتحملها القسم قبل التحويل (T)، xferMax = سقف الإحالات يوميًا (M).
       لا قيم افتراضية: القسم القائم بلا قيم يظهر للإدارة «يحتاج استكمال»، ولا تُحال حصص حتى تُستكمل. */
    const nn = v => (Number.isInteger(v) && v >= 0 ? v : null);
    const capOf = x => ({ cap: nn(x && x.cap), xferMax: nn(x && x.xferMax) });
    /* القاعدة تُطبَّق على الأيام المعتمدة بعد إضافتها (xferRule في إعدادات اليوم)، والأيام الأقدم تُصحَّح بقواعدها وقت اعتمادها */
    const engineSettings = (st, rule = true) => ({ debt: st.debt, rotation: st.rotation, oneDaily: !!st.oneDaily, adminTransfer: !!st.adminTransfer, capOn: !!(rule && st.adminTransfer), cap: st.cap, xferMax: st.xferMax });
    /* إصدارات الجدول بتاريخ سريان: الإصدار الساري في تاريخ = آخر إصدار بدأ سريانه في ذلك التاريخ أو قبله.
       الإصدارات القديمة بلا تاريخ تسري من البداية. خط زمني صغير على القسم يكفي للحكم دون تحميل خانات كل الإصدارات. */
    const effOf = v => (v && v.effectiveFrom) || '0000-00-00';
    function timelineOf(dep) {
      if (Array.isArray(dep.scheduleTimeline) && dep.scheduleTimeline.length) return dep.scheduleTimeline;
      const list = (dep.scheduleVersions && dep.scheduleVersions.length) ? dep.scheduleVersions : (dep.scheduleApproved ? [dep.scheduleApproved] : []);
      return list.map(v => ({ version: v.version, effectiveFrom: v.effectiveFrom || null, days: v.days, kind: (v.source && v.source.kind) || null }));
    }
    /* ---------- مصدر جدول القسم ----------
       لكل قسم مصدر فعّال واحد لكل تاريخ: «الإدارة» (إصدارات جدول المدرسة المعتمد المفعّل، تُكتب تلقائيًا عند كل اعتماد
       مرتبطة به، ولا تُعدَّل من القسم) أو «الجدول الداخلي» (إصدارات Excel المعتمدة للقسم). dep.schedSource سجل بتواريخ سريان.
       قبل أول اختيار محفوظ (الأقسام القائمة): السلوك السابق كما هو (أحدث إصدار ساري أيًا كان مصدره)، ولا يُفرض مصدر. */
    const SRC_NAME = { admin: 'الإدارة', internal: 'الجدول الداخلي' };
    const isAdminKind = k => k === 'school-timetable';
    const kindOkFor = (src, k) => (src === 'admin' ? isAdminKind(k) : src === 'internal' ? k === 'internal-tt' : k !== 'internal-tt');
    function srcEntryAt(dep, date) {
      let best = null;
      for (const e of dep.schedSource || []) if (e.from <= date && (!best || e.from >= best.from)) best = e;
      return best;
    }
    const srcAt = (dep, date) => { const e = srcEntryAt(dep, date); return e ? e.source : null; };
    function metaAt(dep, date, src) {
      const want = src === undefined ? srcAt(dep, date) : src;
      let best = null;
      for (const v of timelineOf(dep)) if (!v.cancelled && effOf(v) <= date && kindOkFor(want, v.kind) && (!best || v.version > best.version)) best = v;
      return best;
    }
    // المصدر الفعلي اليوم: المحفوظ، أو (للقسم القائم دون اختيار محفوظ) مصدر الإصدار الساري — موثّق من نوع الإصدار نفسه
    function srcNow(dep, date) {
      const e = srcEntryAt(dep, date); if (e) return { source: e.source, saved: true, from: e.from, by: e.by || '', at: e.at || null };
      const m = metaAt(dep, date, null);
      return { source: m ? (isAdminKind(m.kind) ? 'admin' : 'internal') : null, saved: false, from: null, by: '', at: null };
    }
    // سبب عدم وجود جدول صالح للمصدر في التاريخ (لا تخمين ولا انتقال تلقائي للمصدر الآخر)
    function srcMissing(dep, date, src) {
      if (src === 'admin') return 'المصدر المختار «الإدارة»: لا يوجد جدول مدرسة معتمد ومفعّل لهذا القسم يسري في ' + date + '. يعتمده المسؤول من «جدول المدرسة» ويفعّله للاحتياط.';
      if (src === 'internal') return 'المصدر المختار «الجدول الداخلي»: يُبنى فوق جدول الإدارة، ولا يوجد جدول إدارة معتمد ومفعّل لهذا القسم يسري في ' + date + '.';
      return null;
    }
    // آخر إصدار للمصدر الحالي (أي تاريخ): لجاهزية القسم في اللوحات
    function srcLatest(dep, date) {
      const src = srcAt(dep, date);
      let best = null; for (const v of timelineOf(dep)) if (!v.cancelled && kindOkFor(src, v.kind) && (!best || v.version > best.version)) best = v;
      return best;
    }
    function schedAt(dep, date) {
      const m = metaAt(dep, date); if (!m) return null;
      return (dep.scheduleVersions || []).find(v => v.version === m.version) || (dep.scheduleApproved && dep.scheduleApproved.version === m.version ? dep.scheduleApproved : null);
    }
    /* لا استبدال صامت لجدول مفعّل من «جدول المدرسة» باستيراد Excel: يلزم تأكيد صريح، ثم يُلغى أي إصدار منه مجدول لتاريخ لاحق (يبقى في السجل) */
    function excelOverTimetable(d, ctx, dep, a) {
      const today = kuwaitToday(now());
      const inForce = metaAt(dep, today);
      // القسم الذي اختار مصدره صراحة: الإصداران منفصلان ولا يستبدل أحدهما الآخر (يُستخدم ما يطابق المصدر المختار فقط)
      if ((dep.schedSource || []).length) return;
      const fromTT = timelineOf(dep).some(x => !x.cancelled && x.kind === 'school-timetable' && (effOf(x) > today || (inForce && inForce.version === x.version)));
      if (!fromTT) return;
      if (!a.replaceTimetable) fail('جدول هذا القسم مفعّل من «جدول المدرسة». اعتماد ملف Excel يستبدله لهذا القسم فقط (الأيام المعتمدة سابقًا لا تتغير). أكّد الاستبدال صراحة أو عدّل من «جدول المدرسة».', 'confirm_replace');
      const dropped = [];
      dep.scheduleTimeline = timelineOf(dep).map(x => (!x.cancelled && effOf(x) > today) ? (dropped.push(x.version), { ...x, cancelled: true }) : x);
      if (dropped.length) audit(d, ctx, 'إلغاء إصدار مجدول من جدول المدرسة', `الإصدارات ${dropped.join('، ')} — استُبدلت بملف Excel`, dep.id);
    }
    function addScheduleVersion(dep, v) {
      const tl = timelineOf(dep).slice();
      dep.scheduleApproved = v;
      dep.scheduleVersions = (dep.scheduleVersions || []).concat([v]);
      tl.push({ version: v.version, effectiveFrom: v.effectiveFrom || null, days: v.days, kind: (v.source && v.source.kind) || null });
      dep.scheduleTimeline = tl;
    }
    function needDebt(dep) { if (!settingsOf(dep).debt) fail('جدول الدين غير مفعّل لهذا القسم؛ أدوات تعديل الدين معطّلة.', 'disabled'); }
    function needRotation(dep) { if (!settingsOf(dep).rotation) fail('الدور غير مفعّل لهذا القسم؛ أدوات التحكم بالدور معطّلة.', 'disabled'); }
    // الإحالات إلى الإدارة المرسلة من المتصفح: مفاتيح نصية فقط، ولا تُقبل إلا إذا كان الخيار مسموحًا
    function cleanTransfers(list, allowed, keep) {
      const arr = Array.isArray(list) ? list.map(x => String(x).slice(0, 200)) : [];
      const uniq = Array.from(new Set(arr)).slice(0, 300);
      const keepSet = new Set(keep || []);
      if (uniq.some(k => !keepSet.has(k)) && !allowed) fail('تحويل الحصص إلى الإدارة غير مسموح لهذا القسم. تحدده إدارة المدرسة من سياسة التحويل للإدارة.', 'disabled');
      return uniq;
    }

    function deptView(d, dept, ctx) {
      return {
        id: dept.id, name: dept.name, school: dept.school || '', status: dept.status,
        schoolId: dept.schoolId || null, schoolName: dept.schoolId ? ((schoolIn(d, dept.schoolId) || {}).name || null) : null,
        headTeacherId: dept.headTeacherId || null,
        headName: dept.headTeacherId ? (d.teachers.find(t => t.id === dept.headTeacherId) || {}).name || null : null,
        deputyTeacherIds: (dept.deputyTeacherIds || []).slice(),
        deputies: (dept.deputyTeacherIds || []).map(id => ({ teacherId: id, name: (d.teachers.find(t => t.id === id) || {}).name || '—' })),
        scheduleApproved: !!dept.scheduleApproved,
        schedSource: srcNow(dept, kuwaitToday(now())).source,
        schedReady: (v => (v ? { version: v.version, days: v.days } : null))(srcLatest(dept, kuwaitToday(now()))),
        scheduleVersion: dept.scheduleApproved ? dept.scheduleApproved.version : null,
        scheduleApprovedAt: dept.scheduleApproved ? dept.scheduleApproved.approvedAt : null,
        scheduleDays: dept.scheduleApproved ? dept.scheduleApproved.days : [],
        stateConfirmed: !!dept.state.confirmed,
        // قسم لم يُستكمل إعداده: لا يُشغَّل له توزيع غير مكتمل
        needsSetup: !dept.headTeacherId || !srcLatest(dept, kuwaitToday(now())) || !dept.state.confirmed,
        settings: settingsOf(dept),
        attOn: !!(dept.attOn && dept.attOn.on),
        attRemind: !!(dept.attRemind && dept.attRemind.on),
        attPresence: !!(dept.attPresence && dept.attPresence.on),
        // من يعدّل «تذكير تسجيل حالة الحضور»: مدير النظام وإدارة المدرسة، ورئيس القسم الأصلي لقسمه (لا النواب ولا المفوَّضون)
        attRemindEdit: !ctx || ctx.role === 'admin' || ctx.role === 'school' || (ctx.role === 'head' && ctx.kind === 'head' && ctx.deptId === dept.id && !ctx.viaGrant),
        // ما يملكه الحساب الحالي في هذا القسم: كامل (المنظّم، المدرسة، قسم رئيس القسم الأصلي) أو صلاحيات مفوّضة محددة
        access: !ctx || ctx.role !== 'head' ? { full: true, native: false, perms: [] } : { full: false, native: ctx.deptId === dept.id, perms: Array.from(permsIn(ctx, dept.id)), via: Array.from(new Set((ctx.grants || []).filter(g => g.deptIds.includes(dept.id)).map(g => g.grantorName))) },
        demo: !!dept.demo,
        teacherCount: teachersOf(d, dept.id).filter(t => t.status === 'active').length
      };
    }

    function prerequisites(d, dept, date) {
      const dayKey = Engine.dayKeyOf(date);
      const sch = metaAt(dept, date);
      const isStudy = !!(dayKey && sch && sch.days.includes(dayKey));
      const issues = [];
      let dayIssue = null;
      if (dept.status !== 'active') issues.push('القسم غير فعّال.');
      if (!dept.headTeacherId) issues.push('لم يُحدَّد رئيس القسم من سجلات المعلمين.');
      const srcMiss = (dept.schedSource || []).length ? srcMissing(dept, date, srcAt(dept, date)) : null;
      if (!sch && srcMiss) issues.push(srcMiss);
      else if (!sch) issues.push(dept.scheduleApproved ? `لا يوجد جدول ساري للقسم في ${date}؛ الجدول المعتمد يبدأ سريانه في ${dept.scheduleApproved.effectiveFrom || '—'}.` : 'لا يوجد جدول معتمد للقسم. يستورده مدير النظام من ملف Excel ويعتمده، أو يُفعَّل من «جدول المدرسة».');
      if (!dept.state.confirmed) issues.push('لم تُعتمد الحالة الافتتاحية للقسم (الديون ونقطة الدور).');
      if (sch && !isStudy) { dayIssue = `الجدول المعتمد (الإصدار ${sch.version}) لا يتضمن يوم ${Engine.DAY_NAMES[dayKey]}. لا يمكن توزيع الاحتياط لهذا التاريخ، ولا يُعتبر ذلك دليلًا على عدم وجود حصص.`; issues.push(dayIssue); }
      const later = d.days.filter(x => x.deptId === dept.id && x.date > date).map(x => x.date).sort();
      if (later.length) issues.push(`يوجد يوم معتمد بتاريخ لاحق (${later[later.length - 1]}). اعتماد تاريخ سابق قد يغيّر نتائج الأيام اللاحقة، لذا هو موقوف في هذه المرحلة.`);
      return { dayKey, isStudy, issues, dayIssue, scheduleVersion: sch ? sch.version : null, scheduleSource: sch ? (isAdminKind(sch.kind) ? 'admin' : 'internal') : srcAt(dept, date) };
    }

    const activeExclusions = (dept, date) => (dept.exclusions || []).filter(x => x.status === 'active' && x.date === date);
    function runEngine(d, dept, date, absentIds, noAbsence, manual, transfers, absentPeriods, swaps) {
      const pre = prerequisites(d, dept, date);
      const st = settingsOf(dept);
      const r = Engine.computeDay({
        settings: engineSettings(st), transfers: cleanTransfers(transfers, st.adminTransfer),
        teachers: teachersOf(d, dept.id).map(t => ({ id: t.id, name: t.name, status: t.status, inRotation: t.inRotation, rotationOrder: t.rotationOrder })),
        headId: dept.headTeacherId,
        dayKey: pre.dayKey, date,
        schedule: SW.effAt(d, dept, date),
        absentIds, noAbsence, absentPeriods: absentPeriods || {}, state: dept.state,
        exclusions: activeExclusions(dept, date).map(x => ({ teacherId: x.teacherId, scope: x.scope, periods: x.periods })),
        manual: cleanManual(manual), swaps: cleanSwaps(swaps), busy: aaBusy(d, dept.id, date)
      });
      if (pre.issues.length) return { ok: false, headline: Engine.MISSING_HEADLINE, missing: pre.issues };
      const conf = aaAbsentConflicts(d, dept, date, absentIds || [], absentPeriods || {});
      if (conf.length) return { ok: false, headline: 'معلم مكلّف من الإدارة مسجل غائبًا.', missing: conf };
      return r;
    }

    // ---------- العمليات ----------
    const ops = {};
    const op = (name, roles, fn) => { ops[name] = { roles, fn }; };
    const PUBLIC = null;

    // -- الدخول والتفعيل --
    op('auth.status', PUBLIC, async () => ({ hasAdmin: !!db.admin, systemName: db.meta.systemName, persistent, production, needsSetupKey: production }));

    // مفتاح الإعداد: سر يضعه المدير في إعدادات الخادم (لا في الواجهة). بدونه لا يمكن إنشاء حساب المدير أو استعادته في نسخة الإنتاج
    async function checkSetupKey(given) {
      if (!production) return;
      if (!setupKey) fail('الإعداد الأولي غير مفعّل على الخادم. أضف مفتاح الإعداد في إعدادات الخادم أولًا.', 'forbidden');
      if (!safeEq(await sha256(String(given || '')), await sha256(setupKey))) fail('مفتاح الإعداد غير صحيح.', 'auth');
    }

    op('auth.setupAdmin', PUBLIC, async (_, a) => {
      if (db.admin) fail('حساب مدير النظام موجود مسبقًا.', 'forbidden');
      await checkSetupKey(a.setupKey);
      const civilId = cleanCivil(a.civilId); const name = cleanName(a.name); checkPassword(a.password);
      if (a.confirm != null && a.password !== a.confirm) fail('كلمتا المرور غير متطابقتين.');
      if (db.accounts.some(x => x.civilId === civilId)) fail('هذا الرقم المدني مستخدم في حساب آخر.');
      const pw = await hashPassword(a.password, null, pwIter);
      return tx(d => {
        if (d.admin) fail('حساب مدير النظام موجود مسبقًا.', 'forbidden');
        d.admin = { name, civilId, pw, createdAt: iso() };
        d.meta.createdAt = iso();
        audit(d, { name, role: 'admin' }, 'إنشاء حساب مدير النظام');
        return { ok: true };
      });
    });

    // استعادة كلمة مرور المدير الوحيد: تتطلب مفتاح الإعداد من إعدادات الخادم (لا يكفي الرقم المدني)
    op('auth.recoverAdmin', PUBLIC, async (_, a) => {
      if (!production) fail('غير متاح في النسخة التجريبية.', 'forbidden');
      await checkSetupKey(a.setupKey);
      const generic = 'البيانات غير صحيحة.';
      let civil; try { civil = cleanCivil(a.civilId); } catch (e) { fail(generic, 'auth'); }
      if (!db.admin || !safeEq(db.admin.civilId, civil)) fail(generic, 'auth');
      checkPassword(a.password); if (a.password !== a.confirm) fail('كلمتا المرور غير متطابقتين.');
      const pw = await hashPassword(a.password, null, pwIter);
      return tx(d => {
        d.admin.pw = pw;
        d.sessions = d.sessions.filter(s => s.role !== 'admin');
        audit(d, { name: d.admin.name, role: 'admin' }, 'استعادة كلمة مرور مدير النظام بمفتاح الإعداد');
        return { ok: true };
      });
    });

    const LOGIN_GENERIC = 'الرقم المدني أو كلمة المرور غير صحيحة، أو الحساب غير مفعّل.';
    op('auth.login', PUBLIC, async (_, a) => {
      let civil; try { civil = cleanCivil(a.civilId); } catch (e) { fail(LOGIN_GENERIC, 'auth'); }
      let role = null, rec = null;
      if (db.admin && db.admin.civilId === civil) { role = 'admin'; rec = db.admin; }
      else { rec = db.accounts.find(x => x.civilId === civil); role = 'head'; }
      // حساب غير موجود أو بلا كلمة مرور: حساب وهمي بالكلفة نفسها حتى لا يكشف الزمن وجود الحساب
      if (!rec || !rec.pw) { await hashPassword(String(a.password || ''), 'x', pwIter); fail(LOGIN_GENERIC, 'auth'); }
      if (!(await verifyPassword(a.password, rec.pw))) fail(LOGIN_GENERIC, 'auth');
      if (role === 'head' && rec.status !== 'active') fail(LOGIN_GENERIC, 'auth');
      const token = randHex(32);
      const tokenHash = await sha256(token);
      return tx(d => {
        d.sessions = d.sessions.filter(s => new Date(s.expiresAt) > now());
        // «تذكّرني على هذا الجهاز»: جلسة طويلة (سنة) فلا يُطلب الدخول كل مرة؛ بدونه 8 ساعات. الخروج من الجهاز ينهيها.
        const remember = a.remember === true;
        const ms = remember ? REMEMBER_DAYS * 864e5 : SESSION_HOURS * 3600e3;
        d.sessions.push({ tokenHash, role, accountId: role === 'head' ? rec.id : null, createdAt: iso(), expiresAt: new Date(now().getTime() + ms).toISOString(), ...(remember ? { remember: true } : {}) });
        return { token, role, expiresAt: d.sessions[d.sessions.length - 1].expiresAt, remember, maxAge: Math.floor(ms / 1000) };
      });
    });

    op('auth.logout', PUBLIC, async (_, a, tokenHash) => {
      if (!tokenHash || !db.sessions.some(s => s.tokenHash === tokenHash)) return { ok: true };
      return tx(d => { d.sessions = d.sessions.filter(s => s.tokenHash !== tokenHash); return { ok: true }; });
    });

    // التحقق من رمز التفعيل/إعادة التعيين قبل إظهار حقلي كلمة المرور. الرقم المدني وحده لا يكفي
    const CODE_GENERIC = 'الرقم المدني أو رمز التفعيل غير صحيح، أو انتهت صلاحية الرمز أو استُخدم.';
    async function findByCode(a) {
      let civil; try { civil = cleanCivil(a.civilId); } catch (e) { fail(CODE_GENERIC, 'auth'); }
      const acc = db.accounts.find(x => x.civilId === civil);
      const given = await sha256(normCode(a.code));
      if (!acc || !acc.code || acc.status === 'disabled' || new Date(acc.code.expiresAt) < now() || !safeEq(given, acc.code.hash)) fail(CODE_GENERIC, 'auth');
      return acc;
    }
    op('auth.verifyCode', PUBLIC, async (_, a) => {
      const acc = await findByCode(a);
      return { ok: true, purpose: acc.code.purpose };
    });

    op('auth.activate', PUBLIC, async (_, a) => {
      const acc = await findByCode(a);
      checkPassword(a.password);
      if (a.password !== a.confirm) fail('كلمتا المرور غير متطابقتين.');
      if (String(a.password).replace(/\s/g, '') === acc.civilId) fail('لا تستخدم رقمك المدني كلمةً للمرور.');
      const pw = await hashPassword(a.password, null, pwIter);
      return tx(d => {
        const x = d.accounts.find(y => y.id === acc.id);
        if (!x.code || x.code.hash !== acc.code.hash) fail(CODE_GENERIC, 'auth');
        const purpose = x.code.purpose;
        x.pw = pw; x.code = null; x.status = 'active'; x.activatedAt = iso();
        d.sessions = d.sessions.filter(s => s.accountId !== x.id);
        audit(d, { name: x.name, role: 'head' }, purpose === 'reset' ? 'إكمال إعادة تعيين كلمة المرور' : 'تفعيل الحساب وتعيين كلمة المرور', '', x.deptId);
        return { ok: true };
      });
    });

    // -- حسابي --
    // تفضيلات الواجهة لكل حساب (تبقى بعد الخروج والدخول): الشروحات ظاهرة افتراضيًا حتى يخفيها صاحب الحساب
    const prefsOf = rec => ({ help: !(rec && rec.prefs && rec.prefs.help === false), home: rec && rec.prefs && rec.prefs.home && typeof rec.prefs.home === 'object' ? structuredClone(rec.prefs.home) : null });
    // تخصيص الواجهة الرئيسية لكل حساب: البطاقات الظاهرة وترتيبها وخياراتها (القسم المعروض، حجم توقيت الحصص)
    const HOME_IDS = ['now', 'myatt', 'myres', 'turn', 'myday', 'deptatt', 'schoolatt', 'dist', 'deptday', 'debt'];
    function cleanHome(v) {
      if (v == null) return null;
      if (typeof v !== 'object' || Array.isArray(v)) fail('قيمة غير صالحة.');
      const ids = x => Array.from(new Set((Array.isArray(x) ? x : []).map(String).filter(k => HOME_IDS.includes(k))));
      const order = ids(v.order), on = ids(v.on);
      const o = v.opts && typeof v.opts === 'object' ? v.opts : {};
      const opts = {};
      if (typeof o.dept === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(o.dept)) opts.dept = o.dept;
      if (['full', 'short', 'none'].includes(o.bellsize)) opts.bellsize = o.bellsize;
      return { v: 1, order, on, opts };
    }
    op('me.homeSave', ['admin', 'head', 'teacher'], async (ctx, a) => tx(d => {
      const rec = ctx.role === 'admin' ? d.admin : d.accounts.find(x => x.id === ctx.id);
      if (!rec) fail('الحساب غير موجود.', 'not_found');
      const home = cleanHome(a && a.home);
      const prefs = { ...(rec.prefs && typeof rec.prefs === 'object' ? rec.prefs : {}) };
      if (home) prefs.home = home; else delete prefs.home;
      rec.prefs = prefs;
      return { prefs: prefsOf(rec) };
    }));
    op('me.get', ['admin', 'head', 'teacher'], async (ctx, a, tokenHash) => {
      const out = await meGet(ctx);
      out.prefs = prefsOf(ctx.role === 'admin' ? db.admin : db.accounts.find(x => x.id === ctx.id));
      // «تذكّرني»: تجديد منزلق للجلسة عند فتح البرنامج (مرة كل شهر تقريبًا)، وإعادة ضبط عمر ملف الارتباط بعمر الجلسة
      if (!ctx.preview && tokenHash) {
        let s0 = db.sessions.find(x => x.tokenHash === tokenHash);
        if (s0 && s0.remember && new Date(s0.expiresAt).getTime() - now().getTime() < RENEW_BELOW_DAYS * 864e5) {
          await tx(d => { const x = d.sessions.find(y => y.tokenHash === tokenHash); if (x) { x.expiresAt = new Date(now().getTime() + REMEMBER_DAYS * 864e5).toISOString(); x.renewedAt = iso(); } });
          s0 = db.sessions.find(x => x.tokenHash === tokenHash);
        }
        if (s0) out.session = s0.remember ? { remember: true, maxAge: Math.max(0, Math.floor((new Date(s0.expiresAt).getTime() - now().getTime()) / 1000)) } : { remember: false };
      }
      return out;
    });
    // ربط حساب مدير النظام بسجل معلم (اختياري، يحدده المدير بنفسه): لعرض تكليفاته في «توقيت اليوم» فقط، دون أي صلاحية إضافية
    const adminTeacherOf = d => { const id = d.admin && d.admin.teacherId; const t = id ? d.teachers.find(x => x.id === id) : null; return t && t.status === 'active' ? t : null; };
    op('admin.teacherOptions', ['admin'], async ctx => {
      if (ctx.role !== 'admin') fail('هذه العملية من صلاحيات مدير النظام فقط.', 'forbidden');
      const cur = adminTeacherOf(db);
      const list = db.teachers.filter(t => t.status === 'active').map(t => { const dep = deptIn(db, t.deptId); const sc = dep && dep.schoolId ? schoolIn(db, dep.schoolId) : null; return { id: t.id, name: t.name, deptName: dep ? dep.name : '', schoolName: sc ? sc.name : '' }; })
        .sort((x, y) => (x.schoolName + x.deptName + x.name).localeCompare(y.schoolName + y.deptName + y.name, 'ar'));
      return { current: cur ? cur.id : null, teachers: list };
    });
    op('admin.teacherLink', ['admin'], async (ctx, a) => tx(d => {
      if (ctx.role !== 'admin') fail('هذه العملية من صلاحيات مدير النظام فقط.', 'forbidden');
      const id = a && a.teacherId ? String(a.teacherId) : null;
      const t = id ? d.teachers.find(x => x.id === id && x.status === 'active') : null;
      if (id && !t) fail('سجل المعلم غير موجود أو غير فعّال.', 'not_found');
      const old = adminTeacherOf(d);
      if (t) d.admin.teacherId = t.id; else delete d.admin.teacherId;
      audit(d, ctx, t ? 'ربط حساب مدير النظام بسجل معلم' : 'إلغاء ربط حساب مدير النظام بسجل معلم', t ? `${t.name}${old && old.id !== t.id ? ' (بدل ' + old.name + ')' : ''} — لعرض تكليفاته في توقيت اليوم فقط` : (old ? old.name : ''), t ? t.deptId : null);
      return { teacher: t ? { id: t.id, name: t.name } : null };
    }));
    op('me.prefs', ['admin', 'head', 'teacher'], async (ctx, a) => tx(d => {
      if (typeof (a && a.help) !== 'boolean') fail('قيمة غير صالحة.');
      const rec = ctx.role === 'admin' ? d.admin : d.accounts.find(x => x.id === ctx.id);
      if (!rec) fail('الحساب غير موجود.', 'not_found');
      rec.prefs = { ...(rec.prefs && typeof rec.prefs === 'object' ? rec.prefs : {}), help: a.help };
      return { prefs: prefsOf(rec) };
    }));
    const meGet = async ctx => {
      if (ctx.role === 'teacher') {
        const a = db.accounts.find(x => x.id === ctx.id), t = db.teachers.find(x => x.id === ctx.teacherId), dep = deptIn(db, ctx.deptId), sc = ctx.schoolId ? schoolIn(db, ctx.schoolId) : null;
        return { role: 'teacher', kind: 'teacher', teacherLinked: true, trainee: !!t.trainee, name: a.name, civilMasked: maskCivil(a.civilId), teacherId: t.id, teacherName: t.name, deptId: dep.id, deptName: dep.name, schoolName: sc ? sc.name : '', systemName: db.meta.systemName };
      }
      if (ctx.role === 'admin') {
        const at = adminTeacherOf(db); const adep = at ? deptIn(db, at.deptId) : null;
        return { role: 'admin', name: db.admin.name, civilMasked: maskCivil(db.admin.civilId), systemName: db.meta.systemName,
          adminTeacher: at ? { id: at.id, name: at.name, deptName: adep ? adep.name : '', schoolId: adep ? adep.schoolId || null : null } : null };
      }
      if (ctx.role === 'school') {
        const a = db.accounts.find(x => x.id === ctx.id); const sc = schoolIn(db, ctx.schoolId);
        return { role: 'school', kind: ctx.kind, name: a.name, civilMasked: maskCivil(a.civilId), schoolId: sc.id, schoolName: sc.name, systemName: db.meta.systemName };
      }
      const a = db.accounts.find(x => x.id === ctx.id); const dept = deptIn(db, a.deptId);
      // التفويضات السارية: مصدر كل تفويض ومن منحه ونطاقه ومدته
      const today = kuwaitToday(now());
      const grants = (db.delegations || []).filter(g => g.granteeId === a.id && ['active', 'scheduled'].includes(delegationState(db, g, today))).map(g => {
        const live = (ctx.grants || []).find(x => x.id === g.id);
        return { id: g.id, state: delegationState(db, g, today), grantorName: g.grantorName, perms: g.perms.slice(), permNames: g.perms.map(k => (PERMS.find(x => x.key === k) || {}).label || k),
          allDepts: !!g.allDepts, deptIds: live ? live.deptIds.slice() : [], deptNames: g.allDepts ? ['المدرسة كلها'] : (g.deptIds || []).map(id => (deptIn(db, id) || {}).name || '—'),
          startDate: g.startDate, endDate: g.endDate || null, note: g.note || '', schoolId: g.schoolId, schoolName: (schoolIn(db, g.schoolId) || {}).name || '' };
      });
      const lt = SW.linkedTeacherOfAcc(db, a);
      return { role: 'head', kind: ctx.kind, name: a.name, civilMasked: maskCivil(a.civilId), deptId: a.deptId, deptName: dept ? dept.name : '', systemName: db.meta.systemName, grants, teacherLinked: !!lt, teacherName: lt ? lt.name : null };
    };
    op('me.changePassword', ['admin', 'head', 'teacher'], async (ctx, a, tokenHash) => {
      checkPassword(a.next); if (a.next !== a.confirm) fail('كلمتا المرور غير متطابقتين.');
      const rec = ctx.role === 'admin' ? db.admin : db.accounts.find(x => x.id === ctx.id);
      if (!(await verifyPassword(a.current, rec.pw))) fail('كلمة المرور الحالية غير صحيحة.');
      if (String(a.next).replace(/\s/g, '') === rec.civilId) fail('لا تستخدم رقمك المدني كلمةً للمرور.');
      const pw = await hashPassword(a.next, null, pwIter);
      return tx(d => {
        const r = ctx.role === 'admin' ? d.admin : d.accounts.find(x => x.id === ctx.id);
        r.pw = pw;
        d.sessions = d.sessions.filter(s => s.tokenHash === tokenHash || (ctx.role === 'admin' ? s.role !== 'admin' : s.accountId !== ctx.id));
        audit(d, ctx, 'تغيير كلمة المرور', '', ctx.deptId);
        return { ok: true };
      });
    });

    // -- إعدادات النظام --
    op('system.setName', ['admin'], async (ctx, a) => tx(d => {
      const n = cleanName(a.name, 'اسم النظام'); const old = d.meta.systemName; d.meta.systemName = n;
      audit(d, ctx, 'تعديل اسم النظام', `${old} ← ${n}`); return { ok: true };
    }));
    op('system.wipe', ['admin'], async (ctx, a) => {
      if (production) fail('الحذف الشامل غير متاح في نسخة الإنتاج.', 'forbidden');
      if (a.confirmText !== 'حذف') fail('اكتب كلمة «حذف» للتأكيد.');
      const e = emptyDb(); commit(e); return { ok: true };
    });

    // -- لوحة المدير --
    op('admin.dashboard', ['admin'], async () => {
      const today = kuwaitToday(now());
      const depts = db.departments.map(dep => {
        const pre = prerequisites(db, dep, today);
        const rec = db.days.find(x => x.deptId === dep.id && x.date === today);
        let status;
        if (dep.status !== 'active') status = { key: 'inactive', label: 'غير فعّال' };
        else if (rec) status = rec.noAbsence ? { key: 'approved_none', label: 'معتمد — لا يوجد غياب' } : { key: 'approved', label: `معتمد — ${rec.result.slots.length} احتياط` };
        else if (!srcLatest(dep, kuwaitToday(now()))) status = { key: 'noschedule', label: 'لا يوجد جدول معتمد' };
        else if (!pre.isStudy) status = { key: 'off', label: 'اليوم غير موجود في الجدول' };
        else status = { key: 'pending', label: 'لم يُعتمد اليوم' };
        return {
          ...deptView(db, dep, { role: 'admin' }), today: status,
          covered: rec ? rec.result.slots.filter(s => s.status === 'covered').length : 0,
          uncovered: rec ? rec.result.uncovered.length : 0
        };
      });
      return {
        today,
        counts: {
          departments: db.departments.length,
          teachers: db.teachers.filter(t => t.status === 'active').length,
          accounts: db.accounts.length,
          accountsActive: db.accounts.filter(a => a.status === 'active').length,
          approvedToday: depts.filter(x => x.today.key.startsWith('approved')).length,
          coveredToday: depts.reduce((s, x) => s + x.covered, 0),
          uncoveredToday: depts.reduce((s, x) => s + x.uncovered, 0),
          schools: (db.schools || []).length,
          unlinked: db.departments.filter(x => !x.schoolId && !x.demo).length
        },
        departments: depts
      };
    });

    // -- الأقسام --
    op('dept.list', ['admin', 'head'], async ctx => {
      const ext = new Set(); for (const g of ctx.grants || []) for (const id of g.deptIds) ext.add(id);
      const list = ctx.role === 'admin' ? db.departments : ctx.role === 'school' ? deptsOfSchool(db, ctx.schoolId) : db.departments.filter(x => x.id === ctx.deptId || ext.has(x.id));
      return list.map(x => deptView(db, x, ctx));
    });
    op('dept.get', ['admin', 'head'], async (ctx, a) => deptView(db, deptIn(db, scope(ctx, a.deptId)), ctx));
    // القسم الجديد: مدير المدرسة ومساعده ينشئانه في مدرستهما فقط؛ المدير يحدد المدرسة (أو يتركه غير مرتبط)
    function newDept(d, ctx, name, schoolId, extra) {
      if (d.departments.some(x => x.name === name && !x.demo && (x.schoolId || null) === (schoolId || null))) fail(`يوجد قسم بالاسم نفسه «${name}»${schoolId ? ' في هذه المدرسة' : ''}.`);
      const sc = schoolId ? schoolIn(d, schoolId) : null;
      const dep = {
        id: uid('dep'), name, school: sc ? sc.name : String((extra && extra.school) || '').trim().slice(0, 120), status: extra && extra.status === 'inactive' ? 'inactive' : 'active',
        ...(sc ? { schoolId: sc.id } : {}),
        headTeacherId: null, deputyTeacherIds: [], scheduleApproved: null, scheduleVersions: [], importProfile: null, exclusions: [],
        state: { confirmed: false, debts: {}, pointer: null, pending: [], skips: [], pendingSeq: 0, manualNext: null, version: 0 }, backups: [],
        debtJournal: [], legacyMaxDate: null, journalSince: iso(),
        demo: false, createdAt: iso()
      };
      d.departments.push(dep); audit(d, ctx, 'إنشاء قسم', name + (sc ? ` — ${sc.name}` : ''), dep.id);
      return dep;
    }
    op('dept.create', ['admin', 'school'], async (ctx, a) => tx(d => {
      const name = cleanName(a.name, 'اسم القسم');
      if (ctx.role === 'school' || a.schoolId) {
        const sid = ctx.role === 'school' ? ctx.schoolId : a.schoolId;
        if (ctx.role === 'school' && a.schoolId && a.schoolId !== ctx.schoolId) fail('غير مصرح لك بالوصول إلى هذه المدرسة.', 'forbidden');
        if (!schoolIn(d, sid)) fail('المدرسة غير موجودة.', 'not_found');
        return { id: newDept(d, ctx, name, sid, a).id };
      }
      if (d.departments.some(x => x.name === name && !x.demo)) fail('يوجد قسم بالاسم نفسه.');
      const dep = {
        id: uid('dep'), name, school: String(a.school || '').trim().slice(0, 120), status: a.status === 'inactive' ? 'inactive' : 'active',
        headTeacherId: null, deputyTeacherIds: [], scheduleApproved: null, scheduleVersions: [], importProfile: null, exclusions: [],
        state: { confirmed: false, debts: {}, pointer: null, pending: [], skips: [], pendingSeq: 0, manualNext: null, version: 0 }, backups: [],
        debtJournal: [], legacyMaxDate: null, journalSince: iso(),
        demo: !!a.demo, createdAt: iso()
      };
      d.departments.push(dep); audit(d, ctx, 'إنشاء قسم', name, dep.id);
      return { id: dep.id };
    }));
    op('dept.update', ['admin', 'school'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId)); const ch = [];
      // اسم المدرسة النصي للقسم المرتبط يتبع سجل المدرسة، ولا يغيّره هذا الطلب
      if (dep.schoolId) delete a.school;
      if (a.name != null) { const n = cleanName(a.name, 'اسم القسم'); if (n !== dep.name) { ch.push(`الاسم: ${dep.name} ← ${n}`); dep.name = n; } }
      if (a.school != null) { const s = String(a.school).trim().slice(0, 120); if (s !== dep.school) { ch.push('اسم المدرسة'); dep.school = s; } }
      if (a.status != null) { const s = a.status === 'inactive' ? 'inactive' : 'active'; if (s !== dep.status) { ch.push(`الحالة: ${s === 'active' ? 'فعّال' : 'غير فعّال'}`); dep.status = s; } }
      if (a.headTeacherId !== undefined) {
        const hid = a.headTeacherId || null;
        if (hid) { const t = d.teachers.find(x => x.id === hid && x.deptId === dep.id); if (!t) fail('المعلم المحدد ليس من هذا القسم.'); if (t.status !== 'active') fail('لا يمكن تعيين معلم غير فعّال رئيسًا للقسم.'); }
        if (hid && (dep.deputyTeacherIds || []).includes(hid)) fail('هذا المعلم نائب لرئيس القسم؛ أزل صلاحية النائب أولًا من صفحة «نواب رئيس القسم».');
        if (hid !== dep.headTeacherId) { ch.push('رئيس القسم: ' + (hid ? d.teachers.find(x => x.id === hid).name : 'بلا')); dep.headTeacherId = hid; bump(dep); }
      }
      if (a.status != null) bump(dep);
      if (ch.length) audit(d, ctx, 'تعديل بيانات القسم', ch.join('، '), dep.id);
      return { ok: true };
    }));

    // -- طريقة إدارة حصص الاحتياط (إعدادات القسم): المدير لكل الأقسام، ورئيس القسم ونوابه لقسمهم --
    const ST_LABEL = { debt: 'جدول الدين', rotation: 'الدور', adminTransfer: 'التحويل إلى الإدارة', oneDaily: 'حصة احتياط واحدة كحد أقصى يوميًا' };
    // من يملك سياسة التحويل للإدارة في قسم: المنظّم، وإدارة المدرسة (النطاق يُتحقق منه قبلها)، والمفوَّض بصلاحية deptCap للقسم
    const canXfer = (ctx, depId) => ctx.role === 'admin' || ctx.role === 'school' || (ctx.role === 'head' && permsIn(ctx, depId).has('deptCap'));
    const pick4 = x => ({ debt: x.debt, rotation: x.rotation, adminTransfer: x.adminTransfer, oneDaily: x.oneDaily });
    op('dept.settingsSave', ['admin', 'head'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId));
      requireVersion(dep, a.stateVersion);
      for (const k of ['debt', 'rotation']) if (typeof a[k] !== 'boolean') fail('قيم الإعدادات غير صالحة.');
      for (const k of ['oneDaily', 'adminTransfer']) if (a[k] !== undefined && typeof a[k] !== 'boolean') fail('قيم الإعدادات غير صالحة.');
      const before = settingsOf(dep);
      // سياسة التحويل للإدارة ليست من الإعدادات المشتركة: تُحفظ كما هي، ولا يغيّرها إلا من يملكها (dept.capSave)
      if (a.adminTransfer !== undefined && a.adminTransfer !== before.adminTransfer && !canXfer(ctx, dep.id)) fail('السماح بالتحويل إلى الإدارة من صلاحيات الإدارة (أو بتفويض صريح «إدارة حدود احتياط الأقسام»)؛ لم يُحفظ شيء.', 'forbidden');
      const after = { debt: a.debt, rotation: a.rotation, adminTransfer: a.adminTransfer === undefined ? before.adminTransfer : a.adminTransfer, oneDaily: a.oneDaily === undefined ? before.oneDaily : a.oneDaily };
      if (!after.debt && !after.rotation && !(before.debt === false && before.rotation === false) && a.confirmNoAuto !== true) fail('عند إطفاء الدين والدور معًا لا يوجد توزيع تلقائي على معلمي القسم. أكّد ذلك قبل الحفظ.', 'confirm');
      const ch = Object.keys(ST_LABEL).filter(k => before[k] !== after[k]);
      if (!ch.length) return { ok: true, changed: false, settings: before };
      // حد احتياط القسم له صلاحية مستقلة (dept.capSave)؛ لا يتغير من هنا
      dep.settings = { ...after, cap: before.cap, xferMax: before.xferMax };
      // المسودات غير المعتمدة تحتاج إعادة حساب؛ الأيام المعتمدة لا تتغير
      bump(dep);
      const on = v => (v ? 'مفعّل' : 'مطفأ');
      audit(d, ctx, 'تعديل طريقة إدارة الاحتياط', ch.map(k => `${ST_LABEL[k]}: ${on(before[k])} ← ${on(after[k])}`).join('، '), dep.id, { before: pick4(before), after: pick4(after) });
      // تفعيل الحد اليومي بعد اعتماد يوم فيه أكثر من تكليف لمعلم واحد: اليوم المعتمد لا يتغير
      const warnings = [];
      if (after.oneDaily && !before.oneDaily) {
        const today = kuwaitToday(now());
        const rec = d.days.find(x => x.deptId === dep.id && x.date === today);
        if (rec) {
          const cnt = {}; for (const x of rec.result.slots || []) if (x.status === 'covered' && x.teacherId) cnt[x.teacherId] = (cnt[x.teacherId] || 0) + 1;
          const many = Object.keys(cnt).filter(k => cnt[k] > 1);
          if (many.length) warnings.push(`يوم ${today} معتمد وفيه أكثر من حصة احتياط لـ ${many.map(id => nameIn(d, id)).join('، ')}. اليوم المعتمد لم يتغير؛ أي تصحيح لاحق له يراعي ما نُفّذ فعليًا.`);
        }
      }
      return { ok: true, changed: true, settings: settingsOf(dep), warnings };
    }));

    /* -- الحد الأقصى اليومي لاحتياط القسم: المنظّم ومدير المدرسة ومساعدوه ضمن مدرستهم، والمفوَّض بصلاحية صريحة
       «إدارة حدود احتياط الأقسام» للأقسام المشمولة فقط. رئيس القسم ونوابه يطّلعون عليه ولا يعدّلونه إلا بهذا التفويض. -- */
    op('dept.capSave', ['admin', 'school'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId));
      if (ctx.role === 'head' && !(ctx.viaGrant && grantFor(ctx, 'dept.capSave', dep.id))) fail('سياسة التحويل للإدارة من صلاحيات مدير النظام وإدارة المدرسة، أو بتفويض صريح «إدارة حدود احتياط الأقسام».', 'forbidden');
      requireVersion(dep, a.stateVersion);
      const num = (v, label) => { const n = Number(v); if (v === null || v === '' || !(Number.isInteger(n) && n >= 0 && n <= 200)) fail(`${label} يجب أن يكون عددًا صحيحًا غير سالب.`); return n; };
      if (a.adminTransfer !== undefined && typeof a.adminTransfer !== 'boolean') fail('قيمة السماح بالتحويل غير صالحة.');
      const st0 = settingsOf(dep); const before = { adminTransfer: st0.adminTransfer, cap: st0.cap, xferMax: st0.xferMax };
      const after = {
        adminTransfer: a.adminTransfer === undefined ? before.adminTransfer : a.adminTransfer,
        cap: a.cap === undefined ? before.cap : num(a.cap, 'عدد الحصص التي يتحملها القسم'),
        xferMax: a.xferMax === undefined ? before.xferMax : num(a.xferMax, 'سقف التحويل اليومي')
      };
      if (before.adminTransfer === after.adminTransfer && before.cap === after.cap && before.xferMax === after.xferMax) return { ok: true, changed: false, settings: st0 };
      // الإعدادات المشتركة (الدين والدور والحد الفردي) تبقى كما هي
      dep.settings = { ...(dep.settings || {}), debt: st0.debt, rotation: st0.rotation, oneDaily: st0.oneDaily, adminTransfer: after.adminTransfer, cap: after.cap, xferMax: after.xferMax };
      bump(dep);
      const v = x => (x == null ? 'غير محدد' : x); const on = x => (x ? 'مسموح' : 'غير مسموح');
      const parts = [];
      if (before.adminTransfer !== after.adminTransfer) parts.push(`السماح بالتحويل: ${on(before.adminTransfer)} ← ${on(after.adminTransfer)}`);
      if (before.cap !== after.cap) parts.push(`حد القسم: ${v(before.cap)} ← ${after.cap}`);
      if (before.xferMax !== after.xferMax) parts.push(`سقف التحويل اليومي: ${v(before.xferMax)} ← ${after.xferMax}`);
      audit(d, ctx, 'تعديل قيم التحويل للإدارة', parts.join('، '), dep.id, { before, after });
      const warnings = [];
      const today = kuwaitToday(now());
      const rec = d.days.find(x => x.deptId === dep.id && x.date === today);
      if (rec && after.cap != null && after.xferMax != null) {
        const dem = (rec.result.slots || []).filter(x => !x.orphan).length, tr = (rec.result.slots || []).filter(x => x.status === 'admin').length;
        const al = after.adminTransfer ? Math.min(Math.max(0, dem - after.cap), after.xferMax) : 0;
        if (tr > al) warnings.push(`يوم ${today} معتمد وفيه ${tr} ${tr === 1 ? 'حصة محالة' : 'حصص محالة'} إلى الإدارة، أكثر مما تسمح به القيم الجديدة (${al}). اليوم المعتمد لم يتغير؛ تُطبَّق القيم على الأيام القادمة، ويُعالج اليوم عبر «تعديل غياب اليوم» إن لزم.`);
      }
      if (!after.adminTransfer) warnings.push('«السماح بتحويل حصص إلى الإدارة» مطفأ لهذا القسم؛ حُفظت القيم وتُطبَّق عند تفعيله.');
      else if (after.cap == null || after.xferMax == null) warnings.push('التحويل مسموح لكن القيم غير مكتملة؛ لن تُحال أي حصة حتى يُحدَّد حد القسم وسقف التحويل.');
      return { ok: true, changed: true, settings: settingsOf(dep), warnings };
    }));

    // -- المعلمون --
    const teacherView = (t, dep) => ({ id: t.id, name: t.name, status: t.status, inRotation: t.inRotation, rotationOrder: t.rotationOrder, isHead: dep.headTeacherId === t.id, isDeputy: (dep.deputyTeacherIds || []).includes(t.id), demo: !!t.demo, trainee: !!t.trainee, debt: Math.max(0, dep.state.debts[t.id] || 0), pending: (dep.state.pending || []).some(p => p.teacherId === t.id) });
    op('teacher.list', ['admin', 'head'], async (ctx, a) => {
      const dep = deptIn(db, scope(ctx, a.deptId));
      // أرقام الواتساب: المدير لكل الأقسام، ورئيس القسم ونوابه لمعلمي قسمهم فقط (للقراءة؛ التعديل للمدير وحده)
      // المفوَّض لا يرى أرقام الواتساب إلا بصلاحية «عرض المعلمين» أو «إدارة بيانات المعلمين»
      const hideWa = ctx.role === 'head' && dep.id !== ctx.deptId && !['view', 'teachers'].some(k => permsIn(ctx, dep.id).has(k));
      return teachersOf(db, dep.id).sort((x, y) => x.rotationOrder - y.rotationOrder).map(t => ({ ...teacherView(t, dep), whatsapp: hideWa ? undefined : (t.whatsapp || null) }));
    });
    op('teacher.create', ['admin'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId)); const name = cleanName(a.name, 'اسم المعلم');
      if (teachersOf(d, dep.id).some(t => t.name === name)) fail('يوجد معلم بالاسم نفسه في هذا القسم. أضف ما يميّزه.');
      const order = teachersOf(d, dep.id).reduce((m, t) => Math.max(m, t.rotationOrder), 0) + 1;
      const t = { id: uid('t'), deptId: dep.id, name, status: 'active', inRotation: true, rotationOrder: order, demo: !!dep.demo, createdAt: iso() };
      const wa = cleanWa(a.whatsapp); if (wa) t.whatsapp = wa;
      d.teachers.push(t); audit(d, ctx, 'إضافة معلم', name, dep.id);
      return { id: t.id };
    }));
    /* معلم متدرب من داخل القسم: سجل معلم (متدرب: يرى جدوله فقط، وخارج الدور افتراضيًا حتى لا يوقف التوزيع بلا سطر في الجدول)
       + حساب «معلم» بالرقم المدني برمز تفعيل لمرة واحدة. يُؤرشف لاحقًا من «المعلمون» كأي معلم. */
    op('teacher.addTrainee', ['admin', 'school', 'head'], async (ctx, a) => {
      const dep0 = deptIn(db, scope(ctx, a.deptId));
      if (ctx.role === 'head' && !(ctx.kind === 'head' && ctx.deptId === dep0.id && !ctx.viaGrant)) fail('إضافة المتدربين لرئيس القسم في قسمه، أو مدير النظام والإدارة.', 'forbidden');
      const name = cleanName(a.name, 'اسم المعلم'); const civilId = cleanCivil(a.civilId);
      const wa = a.whatsapp != null && String(a.whatsapp).trim() !== '' ? cleanWa(a.whatsapp) : null;
      if ((db.admin && db.admin.civilId === civilId) || db.accounts.some(x => x.civilId === civilId)) fail('يوجد حساب بهذا الرقم المدني.');
      if (teachersOf(db, dep0.id).some(t => t.name === name)) fail('يوجد معلم بالاسم نفسه في هذا القسم. أضف ما يميّزه.');
      const acc = { id: uid('acc'), name, civilId, deptId: dep0.id, teacherId: null, kind: 'teacher', status: 'pending', pw: null, code: null, createdAt: iso() };
      const code = await issueCode(acc, 'activate');
      return tx(d => {
        const dep = deptIn(d, dep0.id);
        if ((d.admin && d.admin.civilId === civilId) || d.accounts.some(x => x.civilId === civilId)) fail('يوجد حساب بهذا الرقم المدني.');
        const order = teachersOf(d, dep.id).reduce((m, t) => Math.max(m, t.rotationOrder), 0) + 1;
        const t = { id: uid('t'), deptId: dep.id, name, status: 'active', inRotation: (m0 => !!(m0 && m0.kind === ITT_KIND))(metaAt(dep, kuwaitToday(now()))), rotationOrder: order, trainee: true, demo: !!dep.demo, createdAt: iso() };
        if (wa) t.whatsapp = wa;
        d.teachers.push(t); acc.teacherId = t.id; d.accounts.push(acc);
        if (dep.itt) ittMaterialize(d, dep, ctx);
        audit(d, ctx, 'إضافة معلم متدرب', `${name}${t.inRotation ? ' — ضمن الدور' : ' — خارج الدور'}`, dep.id);
        return { teacherId: t.id, account: { id: acc.id, name }, code, expiresAt: acc.code.expiresAt, whatsapp: wa };
      });
    });
    // رقم الواتساب فقط: المدير، ورئيس القسم ونوابه لمعلمي قسمهم. يُحفظ في سجل المعلم نفسه فيراه كل من في القسم.
    op('teacher.setWhatsapp', ['admin', 'head'], async (ctx, a) => tx(d => {
      const t = d.teachers.find(x => x.id === a.teacherId); if (!t) fail('المعلم غير موجود.', 'not_found');
      const dep = deptIn(d, scope(ctx, t.deptId));
      const wa = cleanWa(a.whatsapp);
      if (wa !== (t.whatsapp || null)) {
        if (wa) t.whatsapp = wa; else delete t.whatsapp;
        // الرقم نفسه لا يُكتب في سجل العمليات
        audit(d, ctx, 'تعديل رقم الواتساب', t.name, dep.id);
      }
      return { ok: true, whatsapp: wa };
    }));
    // أرقام الواتساب دفعة واحدة (من ملف Excel): كل المعلمين يجب أن يكونوا من القسم نفسه، وكل الأرقام صالحة، وإلا لا يُحفظ شيء
    op('teacher.setWhatsappBulk', ['admin', 'head'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId));
      const items = Array.isArray(a.items) ? a.items : null;
      if (!items || !items.length) fail('لا توجد أرقام للحفظ.');
      if (items.length > 500) fail('عدد الأسطر أكبر من المسموح (500).');
      const seen = new Set(); const plan = [];
      for (const it of items) {
        const t = d.teachers.find(x => x.id === (it && it.teacherId) && x.deptId === dep.id);
        if (!t) fail('أحد المعلمين في الملف ليس من معلمي هذا القسم. أعد تنزيل الملف من القسم نفسه.');
        if (seen.has(t.id)) fail(`المعلم «${t.name}» مكرر في الملف.`);
        seen.add(t.id);
        let wa; try { wa = cleanWa(it.whatsapp); } catch (e) { fail(`رقم «${t.name}» غير صالح: يجب أن يكون 8 أرقام.`); }
        if (!wa) fail(`رقم «${t.name}» فارغ.`);
        plan.push([t, wa]);
      }
      let changed = 0;
      for (const [t, wa] of plan) if (wa !== (t.whatsapp || null)) { t.whatsapp = wa; changed++; }
      // الأرقام نفسها لا تُكتب في سجل العمليات
      if (changed) audit(d, ctx, 'تعديل أرقام الواتساب من ملف', `${changed} ${changed === 1 ? 'رقم' : 'أرقام'}`, dep.id);
      return { ok: true, changed };
    }));
    op('teacher.update', ['admin'], async (ctx, a) => tx(d => {
      const t = d.teachers.find(x => x.id === a.teacherId); if (!t) fail('المعلم غير موجود.', 'not_found');
      const dep = deptIn(d, scope(ctx, t.deptId)); const ch = [];
      if (a.name != null) { const n = cleanName(a.name, 'اسم المعلم'); if (n !== t.name) { if (teachersOf(d, dep.id).some(x => x.id !== t.id && x.name === n)) fail('يوجد معلم بالاسم نفسه.'); ch.push(`الاسم: ${t.name} ← ${n}`); t.name = n; } }
      if (a.status != null) {
        const s = a.status === 'archived' ? 'archived' : 'active';
        if (s === 'archived' && dep.headTeacherId === t.id) fail('عيّن رئيس قسم آخر قبل أرشفة رئيس القسم الحالي.');
        if (s === 'archived' && (dep.deputyTeacherIds || []).includes(t.id)) fail('هذا المعلم نائب لرئيس القسم؛ أزل صلاحية النائب أولًا ثم أرشفه.');
        if (s !== t.status) { ch.push(s === 'archived' ? 'أرشفة (يُحفظ السجل والدين)' : 'إعادة تفعيل'); t.status = s; }
      }
      if (a.inRotation != null && !!a.inRotation !== t.inRotation) {
        if (!a.inRotation && dep.state.pointer === t.id) fail('هذا المعلم هو نقطة الدور الحالية؛ لا يمكن إخراجه من الدور الآن.');
        t.inRotation = !!a.inRotation; ch.push(t.inRotation ? 'إدخال في ترتيب الدور' : 'إخراج من ترتيب الدور');
      }
      // المعلم المتدرب: حساب معلم عادي، لكن لا يرى «جدول القسم» (جدوله فقط)
      if (a.trainee != null && !!a.trainee !== !!t.trainee) { if (a.trainee) t.trainee = true; else delete t.trainee; ch.push(a.trainee ? 'تحديده متدربًا (يرى جدوله فقط)' : 'إلغاء صفة المتدرب'); }
      let waChanged = false;
      if (a.whatsapp !== undefined) {
        const wa = cleanWa(a.whatsapp);
        if (wa !== (t.whatsapp || null)) { if (wa) t.whatsapp = wa; else delete t.whatsapp; waChanged = true; }
      }
      // الرقم نفسه لا يُكتب في سجل العمليات
      if (waChanged) audit(d, ctx, 'تعديل رقم الواتساب', t.name, dep.id);
      if (ch.length) { audit(d, ctx, 'تعديل معلم', `${t.name}: ${ch.join('، ')}`, dep.id); bump(dep); }
      if (ch.length && dep.itt) ittMaterialize(d, dep, ctx);
      return { ok: true };
    }));
    op('teacher.move', ['admin'], async (ctx, a) => tx(d => {
      const t = d.teachers.find(x => x.id === a.teacherId); if (!t) fail('المعلم غير موجود.', 'not_found');
      const dep = deptIn(d, scope(ctx, t.deptId));
      const list = teachersOf(d, dep.id).sort((x, y) => x.rotationOrder - y.rotationOrder);
      const i = list.indexOf(t); const j = a.dir === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= list.length) return { ok: true };
      const o = list[j].rotationOrder; list[j].rotationOrder = t.rotationOrder; t.rotationOrder = o;
      audit(d, ctx, 'تعديل ترتيب الدور', `${t.name} ↔ ${list[j].name}`, dep.id); bump(dep);
      return { ok: true };
    }));

    // -- إشعار المكلَّفين (واتساب): قائمة تكليفات يوم معتمد مع أرقام المعلمين، للمدير فقط وللقراءة فقط --
    op('notify.dayPlan', ['admin'], async (ctx, a) => {
      const dep = deptIn(db, scope(ctx, a.deptId));
      const date = String(a.date || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('صيغة التاريخ غير صحيحة.');
      const rec = db.days.find(x => x.deptId === dep.id && x.date === date) || null;
      const dk = Engine.dayKeyOf(date);
      const dayText = `${Engine.DAY_NAMES[dk] || ''} ${Number(date.slice(8, 10))}/${Number(date.slice(5, 7))}`.trim();
      if (!rec) return { approved: false, date, dayText, deptName: dep.name, items: [] };
      const slots = (rec.result && Array.isArray(rec.result.slots)) ? rec.result.slots : [];
      const items = slots.filter(s => s && s.teacherId && s.status === 'covered' && s.key).map(s => {
        const t = db.teachers.find(x => x.id === s.teacherId) || null;
        return { key: String(s.key), teacherId: s.teacherId, teacherName: t ? t.name : (s.teacherName || ''), period: s.period, cls: s.cls == null ? '' : String(s.cls), whatsapp: (t && t.whatsapp) || null };
      });
      return { approved: true, date, dayText, deptName: dep.name, items };
    });

    // -- الجدول --
    const versionMeta = v => ({ version: v.version, approvedAt: v.approvedAt, approvedBy: v.approvedBy, source: v.source || null, effectiveFrom: v.effectiveFrom || null, days: v.days, periodsByDay: v.periodsByDay, teachers: v.teacherIds.length, teaching: v.entries.filter(e => e.type === 'teach').length, commitments: v.entries.filter(e => e.type !== 'teach').length });
    op('schedule.get', ['admin', 'head'], async (ctx, a) => {
      const dep = deptIn(db, scope(ctx, a.deptId));
      const today = kuwaitToday(now());
      const cur = schedAt(dep, today);
      const next = timelineOf(dep).filter(x => !x.cancelled && effOf(x) > today && (!cur || x.version > cur.version)).sort((p, q) => (effOf(p) < effOf(q) ? -1 : 1))[0];
      return {
        approved: dep.scheduleApproved ? structuredClone(dep.scheduleApproved) : null,
        current: cur ? structuredClone(cur) : null, upcoming: next ? { version: next.version, effectiveFrom: next.effectiveFrom } : null,
        source: sourceInfo(db, dep, today),
        versions: (dep.scheduleVersions || []).map(v => ({ ...versionMeta(v), cancelled: timelineOf(dep).some(x => x.version === v.version && x.cancelled) })).reverse()
      };
    });
    // حالة مصدر الجدول للقسم: الحالي، والمجدول، وجاهزية كل مصدر (لا يُدمج المصدران ولا يكمل أحدهما الآخر)
    function sourceInfo(d, dep, today) {
      const now0 = srcNow(dep, today);
      const pending = (dep.schedSource || []).filter(e => e.from > today).sort((p, q) => (p.from < q.from ? -1 : 1))[0] || null;
      const active = new Set(teachersOf(d, dep.id).filter(t => t.status === 'active').map(t => t.id));
      const ready = src => {
        const m = metaAt(dep, today, src);
        const later = timelineOf(dep).filter(x => !x.cancelled && kindOkFor(src, x.kind) && effOf(x) > today).sort((p, q) => (effOf(p) < effOf(q) ? -1 : 1))[0] || null;
        const v = m ? (dep.scheduleVersions || []).find(x => x.version === m.version) : null;
        const missing = v ? Array.from(active).filter(id => !v.teacherIds.includes(id) && !(src === 'admin' && (d.teachers.find(t => t.id === id) || {}).trainee)).map(id => nameIn(d, id)) : [];
        const act = v && v.source && v.source.activationId ? v.source.activationId : null;
        return { ready: !!v, version: v ? v.version : null, effectiveFrom: v ? v.effectiveFrom || null : null, approvedAt: v ? v.approvedAt : null, approvedBy: v ? v.approvedBy : null,
          fileName: v && v.source ? v.source.fileName || null : null, activationId: act, missingTeachers: missing, withProblems: v && v.source && v.source.withProblems ? v.source.withProblems : 0,
          upcoming: later ? { version: later.version, effectiveFrom: later.effectiveFrom || null } : null, reason: v ? null : srcMissing(dep, today, src) };
      };
      // الجدول الداخلي يُبنى فوق جدول الإدارة عند الحاجة: جاهز متى وُجد جدول إدارة ساري (ولو لم يُبنَ إصداره بعد)
      const intl = (() => { const r = ready('internal'); const am = metaAt(dep, today, 'admin'); const it = dep.itt || {}; const act = new Set(teachersOf(d, dep.id).filter(t => t.status === 'active').map(t => t.id));
        const moved = Object.values(it.assign || {}).filter(id => act.has(id)).length;
        if (r.ready) return { ...r, base: am ? am.version : null, moved };
        const nextA = timelineOf(dep).filter(x => !x.cancelled && isAdminKind(x.kind) && effOf(x) > today).sort((p, q) => (effOf(p) < effOf(q) ? -1 : 1))[0] || null;
        return am ? { ...r, ready: true, virtual: true, base: am.version, moved, reason: null, missingTeachers: [] } : { ...r, moved, upcoming: nextA ? { version: nextA.version, effectiveFrom: nextA.effectiveFrom || null } : null }; })();
      return { current: now0.source, saved: now0.saved, from: now0.from, by: now0.by, at: now0.at, pending: pending ? { source: pending.source, from: pending.from, by: pending.by, at: pending.at } : null,
        admin: ready('admin'), internal: intl,
        history: (dep.schedSource || []).map(e => ({ source: e.source, from: e.from, by: e.by, at: e.at, prev: e.prev || null })).reverse() };
    }
    /* ================= الجدول الداخلي للقسم (النظام الجديد، 2026-11) =================
       الأوقات دائمًا من جدول الإدارة (إصدارات school-timetable). الجدول الداخلي = تعيينات يدوية «الشعبة ← المعلم» تختلف عن
       الإدارة (dep.itt.assign) + سجل. معلم الشعبة الفعلي = التعيين إن وُجد (ومعلمه فعّال) وإلا معلمها في الإدارة.
       يُبنى منه إصدار جدول حقيقي بنوع «internal-tt» لكل إصدار إدارة ساري/قادم (بتاريخ سريانه)، فيقرؤه الاحتياط كأي جدول
       عندما يكون مصدر القسم «الجدول الداخلي». المتدربون سجلات معلمين حقيقية (trainee) في القسم. */
    const ITT_KIND = 'internal-tt';
    const DK_IDX = k => Engine.DAY_KEYS.indexOf(k);
    const slotCmp = (a, b) => { const [da, pa] = a.split('|'), [db0, pb] = b.split('|'); return DK_IDX(da) - DK_IDX(db0) || Number(pa) - Number(pb); };
    const verObj = (dep, n) => (dep.scheduleVersions || []).find(v => v.version === n) || (dep.scheduleApproved && dep.scheduleApproved.version === n ? dep.scheduleApproved : null);
    const ittOf = dep => { if (!dep.itt || typeof dep.itt !== 'object') dep.itt = { assign: {}, rev: 0, log: [], hist: [], report: null, base: null }; const x = dep.itt; x.assign = x.assign || {}; x.log = x.log || []; x.hist = x.hist || []; return x; };
    // آخر إصدار من الإدارة (للعرض والتحرير): أحدث رقم إصدار غير ملغى
    function adminLatestV(dep) { let best = null; for (const v of timelineOf(dep)) if (!v.cancelled && isAdminKind(v.kind) && (!best || v.version > best.version)) best = v; return best ? verObj(dep, best.version) : null; }
    function secsOf(v) {
      const m = {};
      for (const e of (v && v.entries) || []) if (e.type === 'teach' && e.cls) { const k = String(e.cls).trim(); (m[k] = m[k] || { slots: [], t: e.teacherId }).slots.push(e.day + '|' + e.period); }
      for (const x of Object.values(m)) x.slots.sort(slotCmp);
      return m;
    }
    const ittActive = (d, dep) => new Set(teachersOf(d, dep.id).filter(t => t.status === 'active').map(t => t.id));
    const ittOwner = (it, M, sec, act) => { const a = it.assign[sec]; return a && act.has(a) ? a : M[sec].t; };
    // انشغال معلم في أوقات شعبة: شعبه الأخرى (حسب التوزيع الداخلي) والتزاماته غير التدريسية في جدول الإدارة
    function ittBusy(d, dep, v, M, it, tid, sec, except) {
      const act = ittActive(d, dep), sl = new Set(M[sec].slots);
      for (const [o, x] of Object.entries(M)) { if (o === sec || o === except) continue; if (ittOwner(it, M, o, act) === tid && x.slots.some(s => sl.has(s))) return o; }
      const c = v.entries.find(e => e.teacherId === tid && e.type !== 'teach' && sl.has(e.day + '|' + e.period));
      return c ? (Engine.SLOT_TYPES[c.type] || 'التزام') : null;
    }
    // تركيب جدول داخلي من إصدار إدارة: التعيين يُطبَّق ما لم يتعارض مع خانة أخرى للمعلم نفسه (يبقى عندها معلم الإدارة ويُنبَّه)
    function ittCompose(d, dep, v) {
      const it = ittOf(dep), act = ittActive(d, dep), clash = [];
      const taken = new Set(v.entries.filter(e => !(e.type === 'teach' && e.cls && it.assign[String(e.cls).trim()] && act.has(it.assign[String(e.cls).trim()]))).map(e => e.teacherId + '|' + e.day + '|' + e.period));
      const out = [];
      for (const e of v.entries) {
        const sec = e.type === 'teach' && e.cls ? String(e.cls).trim() : null, to = sec ? it.assign[sec] : null;
        if (to && act.has(to) && to !== e.teacherId) {
          const k = to + '|' + e.day + '|' + e.period;
          if (taken.has(k)) { clash.push(sec); taken.add(e.teacherId + '|' + e.day + '|' + e.period); out.push({ ...e }); continue; }
          taken.add(k); out.push({ ...e, teacherId: to });
        } else out.push({ ...e });
      }
      const ids = Array.from(new Set(v.teacherIds.concat(Array.from(act)))).filter(id => d.teachers.some(t => t.id === id && t.deptId === dep.id));
      return { entries: out, teacherIds: ids, clash: Array.from(new Set(clash)) };
    }
    const usedByDay = (d, dep, ver) => d.days.some(x => x.deptId === dep.id && x.scheduleVersion === ver);
    /* بناء إصدارات «الجدول الداخلي» لإصدار الإدارة الساري اليوم ولكل إصدار إدارة قادم. إصدار داخلي من اليوم نفسه على الأساس نفسه
       ولم يُوزَّع به يوم يُحدَّث في مكانه (لا تكثر الإصدارات مع كل نقل). */
    function ittMaterialize(d, dep, ctx) {
      const today = kuwaitToday(now());
      const inForce = metaAt(dep, today, 'admin');
      const targets = timelineOf(dep).filter(x => !x.cancelled && isAdminKind(x.kind) && (effOf(x) > today || (inForce && x.version === inForce.version)));
      const made = [];
      for (const t of targets) {
        const av = verObj(dep, t.version); if (!av) continue;
        const eff = effOf(t) > today ? t.effectiveFrom : today;
        const c = ittCompose(d, dep, av);
        const tl = timelineOf(dep);
        const same = (dep.scheduleVersions || []).filter(v => v.source && v.source.kind === ITT_KIND && v.source.baseVersion === av.version && v.effectiveFrom === eff).sort((p, q) => q.version - p.version)[0];
        const newest = Math.max(0, ...tl.map(x => x.version));
        if (same && same.version === newest && !usedByDay(d, dep, same.version)) {
          Object.assign(same, { entries: c.entries, teacherIds: c.teacherIds, approvedAt: iso(), approvedBy: ctx ? ctx.name : 'النظام' });
          made.push(same.version); continue;
        }
        if (same && !usedByDay(d, dep, same.version) && JSON.stringify(same.entries) === JSON.stringify(c.entries) && JSON.stringify(same.teacherIds) === JSON.stringify(c.teacherIds)) { made.push(same.version); continue; }
        const v = { version: newest + 1, approvedAt: iso(), approvedBy: ctx ? ctx.name : 'النظام', days: av.days.slice(), periodsByDay: structuredClone(av.periodsByDay), teacherIds: c.teacherIds, entries: c.entries,
          source: { kind: ITT_KIND, baseVersion: av.version, note: `الجدول الداخلي فوق إصدار الإدارة ${av.version}` }, effectiveFrom: eff };
        addScheduleVersion(dep, v); made.push(v.version);
      }
      return made;
    }
    // تقرير «ما تغيّر في الجدول الداخلي» عند وصول إصدار إدارة جديد
    function ittAfterAdmin(d, dep, nv, ctx) {
      const it = dep.itt; if (!it) return;
      const ov = it.base ? verObj(dep, it.base) : null;
      const Mo = ov ? secsOf(ov) : {}, Mn = secsOf(nv), items = [], conf = [];
      const nm = id => nameIn(d, id), dayTxt = sl => sl.map(s => { const [k, p] = s.split('|'); return Engine.DAY_NAMES[k] + ' ' + p; }).join('، ');
      for (const sec of Object.keys(Mn)) {
        const o = Mo[sec], n = Mn[sec], mine = it.assign[sec];
        if (!o) { items.push({ c: 'a', t: `${sec}: شعبة جديدة في جدول الإدارة عند ${nm(n.t)}.` }); continue; }
        if (o.slots.join() !== n.slots.join()) items.push({ c: 't', t: `${sec}: تغيّر الوقت ${dayTxt(o.slots)} ← ${dayTxt(n.slots)}${mine ? ` — وتبقى عند ${nm(mine)} كما وزّعتها` : ''}.` });
        if (o.t !== n.t) {
          if (mine && mine !== n.t) conf.push({ sec, mine, admin: n.t, was: o.t });
          else items.push({ c: 'a', t: `${sec}: غيّرت الإدارة المعلم ${nm(o.t)} ← ${nm(n.t)}${mine === n.t ? ' (وهو نفسه اختيارك)' : ''}.` });
        }
      }
      for (const sec of Object.keys(Mo)) if (!Mn[sec]) items.push({ c: 'a', t: `${sec}: حُذفت من جدول الإدارة.` });
      for (const sec of Object.keys(it.assign)) if (!Mn[sec] || Mn[sec].t === it.assign[sec]) delete it.assign[sec];
      it.base = nv.version;
      it.report = { at: iso(), from: ov ? ov.version : null, to: nv.version, items, conf: conf.map(c => ({ ...c, mineName: nm(c.mine), adminName: nm(c.admin), wasName: nm(c.was) })) };
      ittMaterialize(d, dep, ctx);
    }
    function ittLog(d, dep, ctx, text) { const it = ittOf(dep); it.log = [{ at: iso(), by: ctx ? ctx.name : 'النظام', text }].concat(it.log).slice(0, 200); audit(d, ctx, 'الجدول الداخلي', text, dep.id); }
    // صلاحية التعديل: رئيس القسم الأصلي لقسمه، ومدير النظام والإدارة (scope يتحقق من القسم)
    function ittDep(d, ctx, a, edit) {
      const dep = deptIn(d, scope(ctx, a.deptId));
      if (edit && ctx.role === 'head' && !(ctx.kind === 'head' && ctx.deptId === dep.id && !ctx.viaGrant)) fail('تعديل الجدول الداخلي لرئيس القسم في قسمه، أو مدير النظام والإدارة.', 'forbidden');
      return dep;
    }
    function ittView(d, dep, ctx) {
      const it = ittOf(dep), v = adminLatestV(dep), today = kuwaitToday(now());
      const ts = teachersOf(d, dep.id).filter(t => t.status === 'active').sort((p, q) => (p.rotationOrder ?? 1e9) - (q.rotationOrder ?? 1e9));
      const M = v ? secsOf(v) : {}, act = ittActive(d, dep);
      const comp = v ? ittCompose(d, dep, v) : { clash: [] };
      return {
        rev: it.rev || 0, ready: !!v, baseVersion: v ? v.version : null, baseFrom: v ? v.effectiveFrom || null : null,
        days: v ? v.days : [], periodsByDay: v ? v.periodsByDay : {},
        teachers: ts.map(t => ({ id: t.id, name: t.name, head: dep.headTeacherId === t.id, trainee: !!t.trainee, inRotation: !!t.inRotation })),
        sections: Object.entries(M).map(([sec, x]) => ({ sec, slots: x.slots, admin: x.t, owner: ittOwner(it, M, sec, act), manual: !!(it.assign[sec] && act.has(it.assign[sec]) && it.assign[sec] !== x.t) })),
        commits: v ? v.entries.filter(e => e.type !== 'teach').map(e => ({ t: e.teacherId, s: e.day + '|' + e.period, type: e.type, name: Engine.SLOT_TYPES[e.type] || 'التزام' })) : [],
        clash: comp.clash, report: it.report || null, log: (it.log || []).slice(0, 30), canUndo: (it.hist || []).length > 0,
        source: srcNow(dep, today).source, canEdit: !ctx || ctx.role !== 'head' || (ctx.kind === 'head' && ctx.deptId === dep.id && !ctx.viaGrant)
      };
    }
    op('itt.get', ['admin', 'head'], async (ctx, a) => ittView(db, ittDep(db, ctx, a, false), ctx));
    function ittEdit(name, fn) {
      op(name, ['admin', 'head'], async (ctx, a) => tx(d => {
        const dep = ittDep(d, ctx, a, true); const it = ittOf(dep);
        if (a.rev != null && a.rev !== (it.rev || 0)) fail('تغيّر الجدول الداخلي من حساب آخر. حدّث الصفحة ثم أعد المحاولة.', 'conflict');
        const v = adminLatestV(dep); if (!v) fail('لا يوجد جدول إدارة معتمد لهذا القسم بعد؛ الجدول الداخلي يُبنى فوقه.', 'not_ready');
        if (it.base == null) it.base = v.version;
        const snap = JSON.stringify(it.assign);
        const msg = fn(d, dep, it, v, secsOf(v), a, ctx);
        if (JSON.stringify(it.assign) === snap) return { view: ittView(d, dep, ctx), msg: msg || null, changed: false };
        if (name !== 'itt.undo') it.hist = [snap].concat(it.hist || []).slice(0, 40);
        it.rev = (it.rev || 0) + 1;
        ittMaterialize(d, dep, ctx);
        if (srcNow(dep, kuwaitToday(now())).source === 'internal') bump(dep);
        if (msg) ittLog(d, dep, ctx, msg);
        return { view: ittView(d, dep, ctx), msg: msg || null, changed: true };
      }));
    }
    const ittSet = (it, M, sec, to) => { if (M[sec].t === to) delete it.assign[sec]; else it.assign[sec] = to; };
    const ittTeacher = (d, dep, id) => { const t = d.teachers.find(x => x.id === id && x.deptId === dep.id && x.status === 'active'); if (!t) fail('المعلم ليس من معلمي القسم الفعّالين.', 'forbidden'); return t; };
    ittEdit('itt.move', (d, dep, it, v, M, a) => {
      const sec = String(a.sec || ''); if (!M[sec]) fail('الشعبة غير موجودة في جدول الإدارة.');
      const to = ittTeacher(d, dep, a.to), act = ittActive(d, dep), from = ittOwner(it, M, sec, act);
      if (from === to.id) return null;
      const b = ittBusy(d, dep, v, M, it, to.id, sec);
      if (b) fail(`لا يمكن: ${to.name} عنده ${b} في الوقت نفسه.`, 'conflict');
      ittSet(it, M, sec, to.id);
      return `${sec}: من ${nameIn(d, from)} إلى ${to.name}`;
    });
    ittEdit('itt.swap', (d, dep, it, v, M, a) => {
      const s1 = String(a.a || ''), s2 = String(a.b || ''); if (!M[s1] || !M[s2]) fail('الشعبة غير موجودة في جدول الإدارة.');
      const act = ittActive(d, dep), t1 = ittOwner(it, M, s1, act), t2 = ittOwner(it, M, s2, act);
      if (t1 === t2) return null;
      const x = ittBusy(d, dep, v, M, it, t2, s1, s2), y = ittBusy(d, dep, v, M, it, t1, s2, s1);
      if (x || y) fail(`لا يمكن التبديل: تعارض في الوقت (${x ? nameIn(d, t2) + ' عنده ' + x : nameIn(d, t1) + ' عنده ' + y}).`, 'conflict');
      ittSet(it, M, s1, t2); ittSet(it, M, s2, t1);
      return `تبديل ${s1} ↔ ${s2}`;
    });
    ittEdit('itt.reset', (d, dep, it) => { if (!Object.keys(it.assign).length) return null; it.assign = {}; return 'إعادة التوزيع كما في جدول الإدارة'; });
    ittEdit('itt.undo', (d, dep, it) => { const h = it.hist || []; if (!h.length) fail('لا يوجد ما يُتراجع عنه.'); it.assign = JSON.parse(h[0]); it.hist = h.slice(1); return 'تراجع عن آخر تعديل'; });
    ittEdit('itt.decide', (d, dep, it, v, M, a) => {
      const r = it.report; const i = r ? (r.conf || []).findIndex(c => c.sec === a.sec) : -1; if (i < 0) fail('القرار غير موجود أو اتُّخذ مسبقًا.');
      const c = r.conf[i]; r.conf.splice(i, 1);
      if (a.keep) return null;
      delete it.assign[c.sec]; return `${c.sec}: اعتماد تغيير الإدارة (${nameIn(d, c.admin)})`;
    });
    op('itt.reportClear', ['admin', 'head'], async (ctx, a) => tx(d => { const dep = ittDep(d, ctx, a, true); const it = ittOf(dep); if (it.report) it.report = { ...it.report, items: [], cleared: true }; return { view: ittView(d, dep, ctx) }; }));
    // المتدربون يدخلون الدور مع «الجدول الداخلي» ويخرجون منه مع «الإدارة» (لا يوقفون التوزيع بلا سطر في جدول الإدارة)
    function ittTraineeRotation(d, dep, internal) {
      const st = dep.state || {};
      for (const t of teachersOf(d, dep.id).filter(x => x.trainee && x.status === 'active')) {
        if (internal && !t.inRotation) t.inRotation = true;
        if (!internal && t.inRotation) {
          if (st.pointer === t.id) { const ring = Engine.buildRing(teachersOf(d, dep.id), dep.headTeacherId); const i = ring.indexOf(t.id); st.pointer = ring.length > 1 ? ring[(i - 1 + ring.length) % ring.length] : null; }
          if (st.manualNext === t.id) st.manualNext = null;
          t.inRotation = false;
        }
      }
    }
    /* حفظ مصدر جدول القسم بتاريخ سريان (اليوم أو لاحقًا): رئيس القسم ونوابه لقسمهم، وإدارة المدرسة والمنظّم، والمفوَّض بـ«إدارة جدول القسم».
       يتحقق من وجود جدول صالح للمصدر الجديد في تاريخ السريان، ولا يحذف أي إصدار ولا يغيّر الدين أو الدور أو إعدادات الاحتياط أو الأيام المعتمدة.
       المسودات غير المعتمدة تحتاج إعادة حساب. */
    op('dept.schedSourceSave', ['admin', 'head'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId));
      requireVersion(dep, a.stateVersion);
      const src = a.source === 'admin' || a.source === 'internal' ? a.source : null;
      if (!src) fail('اختر مصدر الجدول: «الإدارة» أو «الجدول الداخلي».');
      const today = kuwaitToday(now());
      const from = a.from == null || a.from === '' ? today : String(a.from);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(new Date(from + 'T12:00:00Z').getTime())) fail('تاريخ بدء السريان غير صالح.');
      if (from < today) fail('تاريخ بدء السريان لا يكون قبل اليوم؛ الأيام السابقة تبقى على مصدرها، وتصحيحها من «تعديل غياب اليوم».');
      if (src === 'internal') { const it = ittOf(dep); const lv = adminLatestV(dep); if (lv && it.base == null) it.base = lv.version; ittMaterialize(d, dep, ctx); }
      if (!metaAt(dep, from, src)) fail(srcMissing(dep, from, src) + ' يبقى المصدر الحالي فعّالًا.', 'not_ready');
      const before = srcNow(dep, from);
      const pendingBefore = (dep.schedSource || []).filter(e => e.from > today);
      if (before.source === src && before.saved && !pendingBefore.some(e => e.from > from)) return { ok: true, changed: false, source: sourceInfo(d, dep, today) };
      // الاختيارات المجدولة لاحقًا تُستبدل بهذا الاختيار؛ السجل السابق (اليوم وما قبله) يبقى كما هو
      const keep = (dep.schedSource || []).filter(e => e.from <= today && e.from !== from);
      const entry = { source: src, from, at: iso(), by: ctx.name, byRole: ctx.role === 'admin' ? 'admin' : ctx.kind, prev: before.source || null };
      // القسم القائم دون اختيار محفوظ: يُثبَّت مصدره الحالي حتى تاريخ السريان (لا يتغير سلوك الأيام قبله)
      const nowSrc = srcNow(dep, today).source;
      if (!(dep.schedSource || []).length && nowSrc && from > today) keep.push({ source: nowSrc, from: today, at: entry.at, by: ctx.name, byRole: entry.byRole, prev: null, implicit: true });
      dep.schedSource = keep.concat([entry]).sort((p, q) => (p.from < q.from ? -1 : p.from > q.from ? 1 : 0));
      if (from === today) ittTraineeRotation(d, dep, src === 'internal');
      bump(dep);
      const nm = x => (x ? SRC_NAME[x] : 'غير محدد');
      const m = metaAt(dep, from, src);
      audit(d, ctx, 'تغيير مصدر جدول القسم', `${nm(before.source)} ← ${nm(src)} — يسري من ${from} (الإصدار ${m.version}${pendingBefore.length ? '؛ أُلغي اختيار مجدول سابق' : ''})`, dep.id, { before: { source: before.source, from: before.from }, after: { source: src, from } });
      return { ok: true, changed: true, source: sourceInfo(d, dep, today) };
    }));
    /* اعتماد جدول مستورد: يتحقق الخادم من البنية والانتماء للقسم من جديد، ولا يمس الديون ولا الدور ولا الأيام المعتمدة */
    op('schedule.approveImport', ['admin'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId));
      const cur = dep.scheduleApproved ? dep.scheduleApproved.version : 0;
      if ((a.baseVersion || 0) !== cur) fail('اعتُمد إصدار آخر من الجدول منذ بدء هذا الاستيراد. أعد مراجعة الفروقات قبل الاعتماد.', 'conflict');
      const ids = new Set(teachersOf(d, dep.id).map(t => t.id));
      const clean = validateSchedulePayload(a.payload, ids);
      const src = a.payload.source || {};
      excelOverTimetable(d, ctx, dep, a);
      const v = {
        version: cur + 1, approvedAt: iso(), approvedBy: ctx.name, ...clean,
        // تعديل دائم: إصدار جديد يسري من تاريخ اعتماده (الأيام السابقة لا تتغير بأثر رجعي، والتبديلات المستقبلية المتأثرة تظهر للمراجعة)
        effectiveFrom: dep.scheduleApproved ? kuwaitToday(now()) : null,
        source: { kind: 'excel', fileName: String(src.fileName || '').slice(0, 160), sheet: String(src.sheet || '').slice(0, 100), fileSize: Number(src.fileSize) || null, mode: src.mode === 'template' ? 'template' : 'mapping' }
      };
      addScheduleVersion(dep, v); bump(dep);
      audit(d, ctx, 'اعتماد جدول القسم من Excel', `الإصدار ${v.version} — ${v.source.fileName} / ${v.source.sheet} — ${v.entries.length} خانة، ${v.teacherIds.length} معلم`, dep.id);
      return { version: v.version };
    }));

    // -- إعدادات الاستيراد المحفوظة (لكل قسم) --
    op('importProfile.get', ['admin'], async (ctx, a) => {
      const dep = deptIn(db, scope(ctx, a.deptId));
      return dep.importProfile ? structuredClone(dep.importProfile) : null;
    });
    op('importProfile.save', ['admin'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId));
      const p = a.profile || {};
      const raw = JSON.stringify(p);
      if (raw.length > 200000) fail('إعدادات الاستيراد أكبر من المسموح.');
      const ids = new Set(teachersOf(d, dep.id).map(t => t.id));
      const links = {};
      for (const [k, v] of Object.entries(p.links || {})) { if (v === '__exclude__' || ids.has(v)) links[String(k).slice(0, 120)] = v; }
      const codes = {};
      for (const [k, v] of Object.entries(p.codes || {})) { if (v && (v.type === 'ignore' || Engine.SLOT_TYPES[v.type])) codes[String(k).slice(0, 120)] = { type: v.type, cls: v.type === 'teach' ? String(v.cls || '').slice(0, 30) : '' }; }
      const c = p.cfg || {};
      const num = x => (Number.isInteger(x) && x >= 0 && x < 100000 ? x : null);
      const cfg = {
        sheet: String(c.sheet || '').slice(0, 100), orientation: c.orientation === 'cols' ? 'cols' : 'rows',
        range: c.range && ['r1', 'c1', 'r2', 'c2'].every(k => num(c.range[k]) != null) ? { r1: c.range.r1, c1: c.range.c1, r2: c.range.r2, c2: c.range.c2 } : null,
        nameLine: num(c.nameLine), dayMode: c.dayMode === 'fixed' ? 'fixed' : 'header', fixedDay: Engine.DAY_KEYS.includes(c.fixedDay) ? c.fixedDay : null,
        dayLine: num(c.dayLine), dayFill: c.dayFill === 'carry' ? 'carry' : 'merge', periodLine: num(c.periodLine), dataStart: num(c.dataStart),
        classPattern: ['slash', 'dash', 'slashdash', 'letter', 'none'].includes(c.classPattern) ? c.classPattern : 'slash',
        classMatch: c.classMatch === 'inside' ? 'inside' : 'whole', mergedData: c.mergedData === 'span' ? 'span' : 'error'
      };
      dep.importProfile = { cfg, links, codes, signature: { slots: num((p.signature || {}).slots) }, savedAt: iso(), savedBy: ctx.name };
      audit(d, ctx, 'حفظ إعدادات استيراد الجدول', `${cfg.sheet} — ${Object.keys(links).length} ربط اسم، ${Object.keys(codes).length} رمز`, dep.id);
      return { ok: true };
    }));

    // -- الحالة الافتتاحية --
    op('state.get', ['admin', 'head'], async (ctx, a) => {
      const dep = deptIn(db, scope(ctx, a.deptId));
      const ring = Engine.buildRing(teachersOf(db, dep.id), dep.headTeacherId);
      const nm = id => (db.teachers.find(t => t.id === id) || {}).name || null;
      const tById = new Map(teachersOf(db, dep.id).map(t => [t.id, t]));
      const nx = Engine.nextPriority(ring, tById, dep.state.pointer, dep.state.pending, dep.state.skips, dep.state.manualNext, dep.state.earlyTurns, dep.state.extraCredits);
      const approvedDates = new Set(db.days.filter(x => x.deptId === dep.id).map(x => x.date));
      const baseNext = Engine.circularFrom(ring, dep.state.pointer).find(id => tById.get(id) && tById.get(id).status === 'active' && !(dep.state.skips || []).includes(id) && !(dep.state.earlyTurns || []).includes(id)) || null;
      return {
        confirmed: dep.state.confirmed, pointer: dep.state.pointer, pointerName: nm(dep.state.pointer),
        next: nx.id, nextName: nm(nx.id), nextKind: nx.kind, baseNext, baseNextName: nm(baseNext),
        ring: ring.map(id => ({ id, name: nm(id), active: tById.get(id).status === 'active' })),
        pending: (dep.state.pending || []).slice().sort((x, y) => x.seq - y.seq).map(p => ({ ...p, name: nm(p.teacherId) })),
        skips: (dep.state.skips || []).map(id => ({ id, name: nm(id) })),
        earlyTurns: (dep.state.earlyTurns || []).map(id => ({ id, name: nm(id) })),
        // رصيد الحصص الإضافية لكل معلم وسجله (الأحدث أولًا)
        extraCredits: structuredClone(dep.state.extraCredits || {}),
        creditLog: (dep.creditLog || []).slice(-150).reverse().map(x => ({ ...x, name: nm(x.teacherId) })),
        exclusions: (dep.exclusions || []).slice().sort((x, y) => (x.date < y.date ? 1 : -1)).slice(0, 60).map(x => ({ ...x, name: nm(x.teacherId), dayApproved: approvedDates.has(x.date) })),
        manualNext: dep.state.manualNext || null, manualNextName: nm(dep.state.manualNext),
        undo: undoStatus(db, dep),
        approvedDates: Array.from(approvedDates).sort().slice(-60),
        backups: (dep.backups || []).slice(-60).reverse().map(b => ({ id: b.id, at: b.at, actor: b.actor, role: b.role, action: b.action, description: b.description, undone: b.undone, undoneAt: b.undoneAt || null, undoneBy: b.undoneBy || null })),
        debts: structuredClone(dep.state.debts), version: dep.state.version,
        resetAt: dep.state.resetAt || null, resetBy: dep.state.resetBy || null, resetCheck: resetCheck(dep),
        dayCount: db.days.filter(x => x.deptId === dep.id).length, clearedDates: (dep.clearedLedger || []).map(x => x.date),
        openingSource: dep.state.openingSource || null, hasDays: db.days.some(x => x.deptId === dep.id),
        settings: settingsOf(dep), resetPart: dep.state.resetPart || null,
        today: kuwaitToday(now())
      };
    });
    op('state.setOpening', ['admin'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId));
      if (d.days.some(x => x.deptId === dep.id)) fail('توجد أيام معتمدة لهذا القسم؛ تعديل الحالة الافتتاحية موقوف حفاظًا على السجل.');
      const ts = teachersOf(d, dep.id); const debts = {};
      for (const t of ts) {
        const v = a.mode === 'fresh' ? 0 : Number((a.debts || {})[t.id] || 0);
        if (!Number.isInteger(v) || v < 0 || v > 999) fail(`قيمة الدين للمعلم «${t.name}» غير صحيحة.`);
        if (v) debts[t.id] = v;
      }
      let pointer = a.mode === 'fresh' ? null : (a.pointer || null);
      if (pointer) { const ring = Engine.buildRing(ts, dep.headTeacherId); if (!ring.includes(pointer)) fail('نقطة الدور يجب أن تكون معلمًا داخل ترتيب الدور.'); }
      journal(dep, ctx, 'opening', dep.state.debts || {}, debts, null, null);
      creditDiffLog(dep, ctx, dep.state.extraCredits, {}, 'reset', { note: 'اعتماد الحالة الافتتاحية' });
      dep.state = { confirmed: true, debts, pointer, pending: [], skips: [], earlyTurns: [], extraCredits: {}, pendingSeq: 0, manualNext: null, version: (dep.state.version || 0) + 1, lastChangeId: 'open_' + randHex(6), openingSource: a.mode === 'fresh' ? 'fresh' : 'transfer' };
      audit(d, ctx, 'اعتماد الحالة الافتتاحية', a.mode === 'fresh' ? 'بداية جديدة: الديون 0 والدور لم يبدأ' : `نقل حالة قائمة: ${Object.keys(debts).length} معلم لديه دين، نقطة الدور: ${pointer ? ts.find(t => t.id === pointer).name : 'لم يبدأ'}`, dep.id);
      return { ok: true };
    }));

    // -- إعادة تسجيل تاريخ مُسح سجله --
    // حركات اليوم الممسوح محفوظة داخليًا (لا تظهر في السجل): يُحسب التسجيل الجديد من حالة ما قبل ذلك اليوم،
    // ويُطبَّق الفرق فقط، فلا يُضاف الدين مرتين ولا يُستهلك الدور مرتين.
    // رصيد الحصص الإضافية: مقارنة وتنظيف وسجل الحركات (إضافة/تصحيح/استهلاك/تصحيح يوم/تراجع/إعادة ضبط)
    const cleanCredits = c => { const o = {}; for (const [k, v] of Object.entries(c || {})) if (Number.isInteger(v) && v > 0) o[k] = v; return o; };
    const sameCredits = (x, y) => JSON.stringify(Object.entries(cleanCredits(x)).sort()) === JSON.stringify(Object.entries(cleanCredits(y)).sort());
    const MAX_CREDIT_LOG = 400;
    function creditLogAdd(dep, ctx, e) {
      const x = { id: uid('cr'), at: iso(), by: ctx ? ctx.name : 'النظام', role: ctx ? (ctx.role === 'admin' ? 'admin' : ctx.kind || 'head') : null, ...e };
      dep.creditLog = (dep.creditLog || []).concat([x]).slice(-MAX_CREDIT_LOG);
      return x;
    }
    // فروق الرصيد بين حالتين تُسجَّل حركات (لكل معلم تغيّر رصيده)
    function creditDiffLog(dep, ctx, before, after, kind, extra) {
      const b = cleanCredits(before), a0 = cleanCredits(after);
      for (const id of new Set(Object.keys(b).concat(Object.keys(a0)))) {
        const x = b[id] || 0, y = a0[id] || 0; if (x === y) continue;
        creditLogAdd(dep, ctx, { kind, teacherId: id, delta: y - x, before: x, after: y, ...(extra || {}) });
      }
    }
    function ledgerFor(dep, date) {
      const e = (dep.clearedLedger || []).find(x => x.date === date);
      if (!e) return null;
      // بعد «إعادة ضبط الدين والدور» لا تعود آثار الحقبة السابقة: التسجيل الجديد حركة جديدة في الدورة الجديدة
      if ((e.epoch || 0) !== (dep.state.epoch || 0)) return null;
      return e;
    }
    /* إعادة تسجيل تاريخ مُسح سجله.
       الأساس هو حالة القسم الحالية بعد استبعاد ما بقي من حركات هذا التاريخ السابقة فقط:
       - الدين: الرصيد الحالي − أثر اليوم الممسوح (المضاف − المسدّد)، ولا يقل عن 0. فإن صُفّر الدين بعد المسح لا يعود.
       - الدور: إذا لم يتغير الدور منذ ذلك اليوم يُعاد من حالة ما قبله (فلا يُستهلك مرتين)، وإلا يُوزَّع من الدور الحالي.
       ثم يُطبَّق التوزيع الجديد مرة واحدة على هذا الأساس. */
    function runRerecord(d, dep, e, absentIds, noAbsence, manual, transfers, swaps) {
      const old = e.record;
      const pre = prerequisites(d, dep, old.date);
      const oldPre = preStateOf(old);
      const cur = dep.state;
      const effect = {};
      for (const x of old.result.debtRows || []) effect[x.id] = (x.remaining || 0) - (x.prev || 0);
      const baseDebts = {};
      for (const t of teachersOf(d, dep.id)) {
        const v = Math.max(0, (cur.debts || {})[t.id] || 0) - (effect[t.id] || 0);
        if (v > 0) baseDebts[t.id] = v;
      }
      const ons = old.result.newState || {};
      const sameIds = (x, y) => JSON.stringify((x || []).slice().sort()) === JSON.stringify((y || []).slice().sort());
      const rotationUnchanged = !e.rotationCut && (ons.pointer || null) === (cur.pointer || null) && (ons.manualNext || null) === (cur.manualNext || null)
        && sameIds((ons.pending || []).map(p => p.teacherId), (cur.pending || []).map(p => p.teacherId)) && sameIds(ons.skips, cur.skips) && sameIds(ons.earlyTurns || [], cur.earlyTurns || []);
      // الرصيد الإضافي يدوي ولا يحرك الدور: لا يدخل في قرار «الدور لم يتغير»، ويُطبَّق فرقه فقط (كالتصحيح)
      const rot = rotationUnchanged
        ? { pointer: oldPre.pointer, pending: oldPre.pending, skips: oldPre.skips, earlyTurns: oldPre.earlyTurns || [], extraCredits: structuredClone(oldPre.extraCredits || {}), pendingSeq: oldPre.pendingSeq, manualNext: oldPre.manualNext }
        : { pointer: cur.pointer || null, pending: structuredClone(cur.pending || []), skips: (cur.skips || []).slice(), earlyTurns: (cur.earlyTurns || []).slice(), extraCredits: structuredClone(cur.extraCredits || {}), pendingSeq: cur.pendingSeq || 0, manualNext: cur.manualNext || null };
      const baseState = { debts: baseDebts, ...rot };
      const st = settingsOf(dep);
      const r = Engine.computeDay({
        settings: engineSettings(st), transfers: cleanTransfers(transfers, st.adminTransfer),
        teachers: teachersOf(d, dep.id).map(t => ({ id: t.id, name: t.name, status: t.status, inRotation: t.inRotation, rotationOrder: t.rotationOrder })),
        headId: dep.headTeacherId, dayKey: old.dayKey || pre.dayKey, date: old.date,
        schedule: scheduleOf(dep, old), absentIds, noAbsence,
        state: { confirmed: true, ...baseState },
        exclusions: (old.exclusions || []).map(x => ({ teacherId: x.teacherId, scope: x.scope, periods: x.periods })),
        manual: cleanManual(manual), swaps: cleanSwaps(swaps), busy: aaBusy(d, dep.id, old.date)
      });
      if (pre.issues.length) return { r: { ok: false, headline: Engine.MISSING_HEADLINE, missing: pre.issues } };
      const conf = aaAbsentConflicts(d, dep, old.date, absentIds || [], {});
      if (conf.length) return { r: { ok: false, headline: 'معلم مكلّف من الإدارة مسجل غائبًا.', missing: conf } };
      if (!r.ok) return { r };
      const nm = id => nameIn(d, id);
      // الرصيد النهائي = الحالي − أثر اليوم السابق + أثر التوزيع الجديد (فلا يضيع تعديل يدوي لاحق ولا يتضاعف شيء)
      const after = structuredClone(r.newState);
      const newEffect = {}; for (const x of r.debtRows || []) newEffect[x.id] = (x.remaining || 0) - (x.prev || 0);
      after.debts = {};
      for (const t of teachersOf(d, dep.id)) {
        const v = Math.max(0, (cur.debts || {})[t.id] || 0) - (effect[t.id] || 0) + (newEffect[t.id] || 0);
        if (v > 0) after.debts[t.id] = v;
      }
      // «مسح السجل وإعادة الدور»: الدور أُعيد من البداية، ولا يُستهلك مرة أخرى بإعادة إنشاء سجل هذا التاريخ
      if (rotationUnchanged) {
        const oC = cleanCredits(ons.extraCredits !== undefined ? ons.extraCredits : oldPre.extraCredits), nC = cleanCredits(r.newState.extraCredits), ec = cleanCredits(cur.extraCredits);
        for (const id of new Set(Object.keys(oC).concat(Object.keys(nC)))) { const v = (ec[id] || 0) + (nC[id] || 0) - (oC[id] || 0); if (v > 0) ec[id] = v; else delete ec[id]; }
        after.extraCredits = ec;
      }
      if (e.rotationCut) Object.assign(after, { pointer: cur.pointer || null, pending: structuredClone(cur.pending || []), skips: (cur.skips || []).slice(), earlyTurns: (cur.earlyTurns || []).slice(), extraCredits: structuredClone(cur.extraCredits || {}), pendingSeq: cur.pendingSeq || 0, manualNext: cur.manualNext || null });
      const debtChanges = [];
      for (const t of teachersOf(d, dep.id)) {
        const b0 = Math.max(0, (cur.debts || {})[t.id] || 0), a0 = Math.max(0, after.debts[t.id] || 0);
        if (b0 !== a0) debtChanges.push({ id: t.id, name: t.name, before: b0, after: a0, delta: a0 - b0 });
      }
      const warnings = [];
      if (!rotationUnchanged) warnings.push(e.rotationCut ? 'أُعيد الدور من البداية عند مسح السجل؛ يُوزَّع الاحتياط من الدور الحالي، ولا يُستهلك الدور مرة أخرى بإعادة تسجيل هذا التاريخ.' : 'تغيّر الدور بعد هذا اليوم؛ يُوزَّع الاحتياط من الدور الحالي.');
      // للعرض والرسالة والطباعة: الأرصدة الفعلية قبل الاعتماد وبعده
      r.debtView = (r.debtRows || []).map(x => { const before = Math.max(0, (cur.debts || {})[x.id] || 0), aft = Math.max(0, after.debts[x.id] || 0); return { id: x.id, name: x.name, status: x.status, prev: before, add: Math.max(0, aft - before), paid: Math.max(0, before - aft), remaining: aft }; });
      // الدور القادم في العرض والرسالة من الحالة الفعلية بعد الاعتماد
      const ts0 = teachersOf(d, dep.id);
      const nx = Engine.nextPriority(Engine.buildRing(ts0, dep.headTeacherId), new Map(ts0.map(t => [t.id, t])), after.pointer, after.pending, after.skips, after.manualNext, after.earlyTurns, after.extraCredits);
      r.nextInRotation = nx.id; r.nextInRotationName = nx.id ? nm(nx.id) : null; r.nextKind = nx.kind;
      r.pendingAfter = (after.pending || []).map(p => ({ ...p, name: nm(p.teacherId) }));
      r.pointerAfterName = after.pointer ? nm(after.pointer) : null;
      r.rerecordNote = true;
      const absNames = res => (res.absentees || []).map(x => x.name);
      const info = {
        clearedAt: e.clearedAt, clearedBy: e.clearedBy, rotationCut: !!e.rotationCut, rotationReplayed: rotationUnchanged,
        previousAbsent: absNames(old.result), sameAbsence: JSON.stringify(absNames(old.result).slice().sort()) === JSON.stringify(absNames(r).slice().sort()),
        debtChanges, warnings, pointerBefore: nm(cur.pointer), pointerAfter: nm(after.pointer)
      };
      return { r, mg: { stateAfter: after, debtChanges, warnings }, info, baseState };
    }

    // -- اليوم --
    op('day.get', ['admin', 'head'], async (ctx, a) => {
      const dep = deptIn(db, scope(ctx, a.deptId));
      const date = String(a.date || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('صيغة التاريخ غير صحيحة.');
      const rec = db.days.find(x => x.deptId === dep.id && x.date === date) || null;
      const pre = prerequisites(db, dep, date);
      // روابط الإدارة: حصص هذا القسم المحالة وما أُسند منها، والتكليفات الواردة إليه في التاريخ
      const links = {};
      if (rec) for (const s0 of rec.result.slots || []) if (s0.status === 'admin') { const act = aaActive(db, refOf(dep.id, date, s0.key)); if (act) links[s0.key] = { state: act.state, teacherName: act.teacherName || null, toDeptName: act.toDeptName || null, source: act.source || null }; }
      const incoming = aaIncoming(db, dep.id, date).map(e => ({ id: e.id, period: e.period, cls: e.cls, srcDeptName: e.srcDeptName, absentName: e.absentName, teacherName: e.teacherName, source: e.source, exec: e.exec, by: e.by }));
      return { record: rec ? structuredClone(rec) : null, prerequisites: pre, stateVersion: dep.state.version, admin: { links, incoming } };
    });
    // الغياب الجزئي في المسودة الأولى (مثل الاستئذان الصباحي): حصص تدريس الغائب في جدول ذلك التاريخ فقط؛ كل حصصه = يوم كامل
    function draftPeriods(d, dep, date, ids, raw) {
      const out = {}; if (!raw || typeof raw !== 'object') return out;
      const sch = SW.effAt(d, dep, date); const dk = Engine.dayKeyOf(date);
      for (const id of ids) {
        const v = raw[id]; if (!Array.isArray(v)) continue;
        const t = d.teachers.find(x => x.id === id); const name = t ? t.name : '';
        const teach = new Set(sch ? sch.entries.filter(e => e.teacherId === id && e.day === dk && e.type === 'teach').map(e => e.period) : []);
        const ps = Array.from(new Set(v.map(Number))).sort((x, y) => x - y);
        if (!ps.length) fail(`اختر حصة واحدة على الأقل لغياب «${name}» الجزئي، أو اجعل غيابه لليوم كاملًا.`);
        for (const p of ps) if (!teach.has(p)) fail(`الحصة ${p} ليست من حصص تدريس «${name}» في جدول ذلك اليوم.`);
        if (ps.length < teach.size) out[id] = ps;
      }
      return out;
    }
    op('day.preview', ['admin', 'head'], async (ctx, a) => {
      const dep = deptIn(db, scope(ctx, a.deptId));
      if (db.days.some(x => x.deptId === dep.id && x.date === a.date)) fail('هذا اليوم معتمد مسبقًا.', 'conflict');
      const ids = (a.absentIds || []).slice(); const per = draftPeriods(db, dep, a.date, ids, a.absentPeriods);
      const e = ledgerFor(dep, a.date);
      if (e) { if (Object.keys(per).length) fail('الغياب الجزئي غير متاح عند إعادة تسجيل تاريخ مُسح سجله؛ سجّل الغياب لليوم كاملًا ثم صحّحه بعد الاعتماد.'); const x = runRerecord(db, dep, e, ids, !!a.noAbsence, a.manual, a.transfers, a.swaps); return { result: x.r, rerecord: x.info || null, stateVersion: dep.state.version }; }
      const r = runEngine(db, dep, a.date, ids, !!a.noAbsence, a.manual, a.transfers, per, a.swaps);
      return { result: r, stateVersion: dep.state.version, absentPeriods: per };
    });
    op('day.approve', ['admin', 'head'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId));
      if (d.days.some(x => x.deptId === dep.id && x.date === a.date)) fail('هذا اليوم معتمد مسبقًا؛ لم يُكرر الحفظ ولم يُضف دين مرة أخرى.', 'conflict');
      if (a.stateVersion !== dep.state.version) fail('تغيّرت حالة القسم منذ إعداد المسودة. أعد حساب المسودة قبل الاعتماد.', 'conflict');
      // يُعاد الحساب في الخادم من البيانات المخزنة، ولا تُقبل نتيجة مرسلة من المتصفح
      const e = ledgerFor(dep, a.date);
      const per = draftPeriods(d, dep, a.date, (a.absentIds || []).slice(), a.absentPeriods);
      if (e && Object.keys(per).length) fail('الغياب الجزئي غير متاح عند إعادة تسجيل تاريخ مُسح سجله؛ سجّل الغياب لليوم كاملًا ثم صحّحه بعد الاعتماد.');
      const rr = e ? runRerecord(d, dep, e, (a.absentIds || []).slice(), !!a.noAbsence, a.manual, a.transfers, a.swaps) : null;
      const r = rr ? rr.r : runEngine(d, dep, a.date, (a.absentIds || []).slice(), !!a.noAbsence, a.manual, a.transfers, per, a.swaps);
      if (!r.ok) fail(r.headline + ' ' + r.missing.join(' '));
      for (const sl of r.slots) delete sl.options; // خيارات التعديل لا تُحفظ في السجل
      const before = { debts: structuredClone(dep.state.debts), pointer: dep.state.pointer, pending: structuredClone(dep.state.pending || []), skips: (dep.state.skips || []).slice(), earlyTurns: (dep.state.earlyTurns || []).slice(), extraCredits: cleanCredits(dep.state.extraCredits) };
      const rec = {
        id: uid('day'), deptId: dep.id, deptName: dep.name, date: a.date, dayKey: Engine.dayKeyOf(a.date),
        noAbsence: !!a.noAbsence, absentIds: r.absentees.map(x => x.id), result: r,
        stateBefore: before, stateAfter: structuredClone(r.newState),
        // حالة القسم قبل اعتماد اليوم كاملة: أساس تصحيح غياب اليوم لاحقًا دون مضاعفة الآثار
        preState: { debts: structuredClone(dep.state.debts), pointer: dep.state.pointer || null, pending: structuredClone(dep.state.pending || []), skips: (dep.state.skips || []).slice(), earlyTurns: (dep.state.earlyTurns || []).slice(), extraCredits: cleanCredits(dep.state.extraCredits), pendingSeq: dep.state.pendingSeq || 0, manualNext: dep.state.manualNext || null },
        absentPeriods: per, epoch: dep.state.epoch || 0,
        scheduleVersion: schedAt(dep, a.date).version, stateVersion: dep.state.version,
        // مصدر الجدول وإصداره المستخدمان في هذا اليوم
        scheduleSource: (s0 => ({ source: isAdminKind(s0.source && s0.source.kind) ? 'admin' : 'internal', version: s0.version, kind: (s0.source && s0.source.kind) || null, activationId: (s0.source && s0.source.activationId) || null, fileName: (s0.source && s0.source.fileName) || null, effectiveFrom: s0.effectiveFrom || null }))(schedAt(dep, a.date)),
        exclusions: activeExclusions(dep, a.date).map(x => ({ teacherId: x.teacherId, scope: x.scope, periods: x.periods, reason: x.reason, note: x.note })),
        approvedBy: ctx.name, approvedRole: ctx.role === 'admin' ? 'admin' : ctx.kind, approvedAt: iso(), demo: !!dep.demo,
        // إعدادات التوزيع المستخدمة في هذا اليوم: تُفسَّر بها نتائجه التاريخية وتصحيحاته لاحقًا
        settings: { ...settingsOf(dep), xferRule: true }
      };
      let next = r.newState;
      if (rr) {
        // إعادة تسجيل تاريخ ممسوح: الأساس حالة ما قبل ذلك اليوم وحركاته المطبّقة سابقًا؛ يُطبَّق الفرق فقط
        next = rr.mg.stateAfter;
        rec.preState = structuredClone(rr.baseState); rec.epoch = dep.state.epoch || 0; rec.rotationCut = !!e.rotationCut;
        rec.scheduleVersion = e.record.scheduleVersion; rec.exclusions = structuredClone(e.record.exclusions || []);
        rec.stateAfter = structuredClone(next);
        rec.rerecord = { clearedAt: e.clearedAt, clearedBy: e.clearedBy, previousAbsentIds: (e.record.absentIds || []).slice(), previousResult: structuredClone(e.record.result), debtChanges: rr.info.debtChanges };
        dep.clearedLedger = dep.clearedLedger.filter(x => x !== e);
      }
      const cleaned = {}; for (const k in next.debts) if (next.debts[k] > 0) cleaned[k] = next.debts[k];
      journal(dep, ctx, rr ? 'rerecord' : 'day', dep.state.debts, cleaned, a.date, rec.id);
      // استهلاك الرصيد الإضافي يُحفظ مع الاعتماد مرة واحدة (المعاينة لا تستهلك شيئًا)
      const crAfter = cleanCredits(next.extraCredits);
      if (!rr) for (const c of r.creditOffsets || []) creditLogAdd(dep, ctx, { kind: 'offset', teacherId: c.teacherId, delta: -c.count, date: a.date, dayId: rec.id, note: `خُصمت ${c.count === 1 ? 'الحصة الزيادة' : c.count + ' حصص زيادة'} من دين غيابه يوم ${a.date}` });
      if (!rr) for (const c of r.consumedCredits || []) creditLogAdd(dep, ctx, { kind: 'use', teacherId: c.teacherId, delta: -1, date: a.date, dayId: rec.id, period: c.period, cls: c.cls, note: `تم استيفاء الدور من الرصيد الإضافي — الحصة ${c.period}، الصف ${c.cls}${c.pending ? ' (حق دور معلّق)' : ''}` });
      else creditDiffLog(dep, ctx, dep.state.extraCredits, crAfter, 'use', { date: a.date, dayId: rec.id, note: 'إعادة تسجيل تاريخ مُسح سجله' });
      dep.state = { ...dep.state, debts: cleaned, pointer: next.pointer, pending: next.pending, skips: next.skips, earlyTurns: (next.earlyTurns || []).slice(), extraCredits: crAfter, pendingSeq: next.pendingSeq, manualNext: next.manualNext, version: dep.state.version + 1, lastChangeId: 'day_' + rec.id };
      d.days.push(rec);
      audit(d, ctx, rr ? 'إعادة تسجيل يوم مُسح سجله' : 'اعتماد يوم', `${a.date} — ${rec.noAbsence ? 'لا يوجد غياب' : `${r.slots.length} حصة، غير مغطاة ${r.uncovered.length}${(r.transferred || []).length ? `، محالة إلى الإدارة ${r.transferred.length}` : ''}`}${rr ? ` — طُبّق الفرق فقط عن الحركات السابقة${rr.info.debtChanges.length ? ': ' + rr.info.debtChanges.map(x => `${x.name} ${x.before}←${x.after}`).join('، ') : ' (لا تغيير في الدين)'}` : ''}`, dep.id);
      return { record: structuredClone(rec) };
    }));
    op('days.list', ['admin', 'head'], async (ctx, a) => {
      const dep = deptIn(db, scope(ctx, a.deptId));
      let list = db.days.filter(x => x.deptId === dep.id);
      if (a.from) list = list.filter(x => x.date >= a.from);
      if (a.to) list = list.filter(x => x.date <= a.to);
      if (a.teacherId) list = list.filter(x => x.absentIds.includes(a.teacherId) || x.result.slots.some(s => s.teacherId === a.teacherId));
      return structuredClone(list.sort((x, y) => (x.date < y.date ? 1 : -1)));
    });

    // -- تصحيح غياب يوم معتمد --
    // حالة القسم قبل اعتماد اليوم: مخزنة للأيام الجديدة، ومشتقة بدقة من حركات اليوم للأيام الأقدم
    function preStateOf(rec) {
      if (rec.preState) return structuredClone(rec.preState);
      const r = rec.result; const ns = r.newState || {};
      const debts = {}; for (const row of r.debtRows || []) if (row.prev > 0) debts[row.id] = row.prev;
      return {
        debts, pointer: r.pointerBefore != null ? r.pointerBefore : null,
        pending: (r.pendingBefore || []).map(p => ({ teacherId: p.teacherId, seq: p.seq, since: p.since })),
        skips: Array.from(new Set((ns.skips || []).concat(r.consumedSkips || []))),
        earlyTurns: (r.earlyBefore || []).map(x => x.teacherId),
        extraCredits: cleanCredits(r.creditsBefore),
        pendingSeq: (ns.pendingSeq || 0) - (r.createdPending || []).length,
        manualNext: r.manualNextBefore || null
      };
    }
    const dayVersionOf = rec => (rec.versions ? rec.versions.length : 1);
    // جدول يوم معتمد: إصداره وقت الاعتماد + التبديلات المؤقتة المعتمدة لذلك التاريخ (الجدول الفعلي)
    const scheduleOf = (dep, rec) => SW.applySwaps(db, dep, rec.date, (dep.scheduleVersions || []).find(v => v.version === rec.scheduleVersion) || dep.scheduleApproved);
    const slotKeyOf = s0 => s0.absentId + '|' + s0.period + '|' + s0.cls;
    function cleanAbsence(d, dep, rec, a) {
      const ids = Array.from(new Set((a.absentIds || []).map(String)));
      const sch = scheduleOf(dep, rec);
      const periods = {};
      for (const id of ids) {
        const t = d.teachers.find(x => x.id === id && x.deptId === dep.id);
        if (!t) fail('أحد الغائبين ليس من معلمي هذا القسم.');
        const raw = (a.absentPeriods || {})[id];
        if (Array.isArray(raw)) {
          const teach = new Set(sch.entries.filter(e => e.teacherId === id && e.day === rec.dayKey && e.type === 'teach').map(e => e.period));
          const ps = Array.from(new Set(raw.map(Number))).sort((x, y) => x - y);
          if (!ps.length) fail(`اختر حصة واحدة على الأقل لغياب «${t.name}» الجزئي، أو اجعل غيابه لليوم كاملًا.`);
          for (const p of ps) if (!teach.has(p)) fail(`الحصة ${p} ليست من حصص تدريس «${t.name}» في جدول ذلك اليوم.`);
          // اختيار كل حصصه = غياب اليوم كاملًا
          if (ps.length < teach.size) periods[id] = ps;
        }
      }
      return { ids, periods };
    }
    // يحسب نسخة اليوم المصححة وأثرها على الحالة الحالية دون حفظ
    /* فرق نسختين لنتيجة اليوم نفسه (المطبَّقة سابقًا ← الجديدة) يُطبَّق على الحالة الحالية مرة واحدة.
       لا تُضاف آثار فوق آثار، ولا تُسترجع حالة قديمة فوق تعديلات لاحقة. opts: { debts, rotation } */
    function mergeDelta(d, dep, old, r, opts) {
      const cur = dep.state; const warnings = [];
      const nm = id => nameIn(d, id);
      const remOf = res => Object.fromEntries((res.debtRows || []).map(x => [x.id, x.remaining]));
      const ro = remOf(old), rn = opts.debts ? remOf(r) : ro;
      const debts = structuredClone(cur.debts || {}); const debtChanges = [];
      for (const id of new Set(Object.keys(ro).concat(Object.keys(rn)))) {
        const delta = (rn[id] || 0) - (ro[id] || 0); if (!delta) continue;
        const before = Math.max(0, debts[id] || 0); let after = before + delta;
        if (after < 0) { warnings.push(`رصيد «${nm(id)}» الحالي (${before}) أقل من مقدار التصحيح؛ أصبح 0 ولم يصبح سالبًا.`); after = 0; }
        if (after) debts[id] = after; else delete debts[id];
        debtChanges.push({ id, name: nm(id), before, after, delta });
      }
      const on = old.newState, nn = opts.rotation ? r.newState : old.newState;
      // الحقوق المعلقة والتخطي: يُطبّق الفرق بين النسختين على الحالة الحالية
      let pending = structuredClone(cur.pending || []); let pendingSeq = Math.max(cur.pendingSeq || 0, nn.pendingSeq || 0);
      const oP = new Set((on.pending || []).map(p => p.teacherId)), nP = new Set((nn.pending || []).map(p => p.teacherId));
      for (const id of oP) if (!nP.has(id)) pending = pending.filter(p => p.teacherId !== id);
      for (const p of nn.pending || []) if (!oP.has(p.teacherId) && !pending.some(x => x.teacherId === p.teacherId)) pending.push({ teacherId: p.teacherId, seq: p.seq, since: p.since });
      let skips = (cur.skips || []).slice();
      const oS = new Set(on.skips || []), nS = new Set(nn.skips || []);
      for (const id of oS) if (!nS.has(id)) skips = skips.filter(x => x !== id);
      for (const id of nS) if (!oS.has(id) && !skips.includes(id)) skips.push(id);
      // الأدوار المبكرة: فرق عددي لكل معلم بين النسختين
      let earlyTurns = (cur.earlyTurns || []).slice();
      const cnt = arr => (arr || []).reduce((m, id) => (m[id] = (m[id] || 0) + 1, m), {});
      const oE = cnt(on.earlyTurns), nE = cnt(nn.earlyTurns);
      for (const id of new Set(Object.keys(oE).concat(Object.keys(nE)))) {
        let d0 = (nE[id] || 0) - (oE[id] || 0);
        while (d0 > 0) { earlyTurns.push(id); d0--; }
        while (d0 < 0) { const i = earlyTurns.indexOf(id); if (i >= 0) earlyTurns.splice(i, 1); d0++; }
      }
      // الرصيد الإضافي: فرق عددي لكل معلم بين النسختين (لا يقل عن 0)؛ الإضافات اليدوية اللاحقة تبقى كما هي
      const extraCredits = cleanCredits(cur.extraCredits);
      { const oC = cleanCredits(on.extraCredits), nC = cleanCredits(nn.extraCredits);
        for (const id of new Set(Object.keys(oC).concat(Object.keys(nC)))) {
          const d0 = (nC[id] || 0) - (oC[id] || 0); if (!d0) continue;
          const v = (extraCredits[id] || 0) + d0;
          if (v < 0) warnings.push(`رصيد «${nm(id)}» الإضافي الحالي أقل من مقدار التصحيح؛ أصبح 0.`);
          if (v > 0) extraCredits[id] = v; else delete extraCredits[id];
        } }
      let manualNext = cur.manualNext || null;
      if ((on.manualNext || null) !== (nn.manualNext || null)) {
        if (manualNext === (on.manualNext || null)) manualNext = nn.manualNext || null;
        else warnings.push('تغيّر «الدور المحدد يدويًا» بعد هذا اليوم، فبقي كما هو الآن ولم يُعدَّل بالتصحيح.');
      }
      let pointer = cur.pointer || null;
      if ((on.pointer || null) !== (nn.pointer || null)) {
        if (pointer === (on.pointer || null)) pointer = nn.pointer || null;
        else warnings.push(`تحرّك مؤشر الدور بعد هذا اليوم (يوم معتمد لاحق أو تعديل يدوي)، فبقي على «${nm(pointer)}» ولم يُرجَع. راجع الدور يدويًا إن لزم.`);
      }
      return { stateAfter: { debts, pointer, pending: pending.sort((x, y) => x.seq - y.seq), skips, earlyTurns, extraCredits, pendingSeq, manualNext }, debtChanges, warnings };
    }
    // التجاوز المؤقت عند تعديل يوم معتمد: القائمة الجديدة كاملة (غير محددة = كما اعتُمد اليوم)
    function cleanCorrExclusions(d, dep, rec, a) {
      const oldL = (rec.exclusions || []).map(x => ({ teacherId: x.teacherId, scope: x.scope === 'periods' ? 'periods' : 'day', periods: (x.periods || []).slice(), reason: x.reason || 'quick', note: x.note || '' }));
      if (!Array.isArray(a.exclusions)) return oldL;
      const sch = scheduleOf(dep, rec); const valid = new Set((sch.periodsByDay || {})[rec.dayKey] || []);
      const out = []; const seen = new Set();
      for (const x of a.exclusions) {
        const tid = String((x && x.teacherId) || ''); if (!tid || seen.has(tid)) continue; seen.add(tid);
        const t = d.teachers.find(y => y.id === tid && y.deptId === dep.id);
        if (!t) fail('معلم التجاوز ليس من معلمي هذا القسم.');
        const prev = oldL.find(y => y.teacherId === tid);
        if (tid === dep.headTeacherId) fail('رئيس القسم معفي من الاحتياط أصلًا؛ لا يحتاج تجاوزًا.');
        if (!prev && t.status !== 'active') fail(`«${t.name}» غير فعّال.`);
        const scopeV = x.scope === 'periods' ? 'periods' : 'day';
        let periods = [];
        if (scopeV === 'periods') { periods = Array.from(new Set((x.periods || []).map(Number))).filter(p => valid.has(p) || (prev && prev.periods.includes(p))).sort((m, n) => m - n); if (!periods.length) fail(`اختر حصة واحدة على الأقل لتجاوز «${t.name}».`); }
        out.push({ teacherId: tid, scope: scopeV, periods, reason: prev ? prev.reason : 'quick', note: prev ? prev.note : '' });
      }
      return out;
    }
    function planCorrection(d, dep, rec, a) {
      if (dayVersionOf(rec) !== a.dayVersion) fail('عُدّل غياب هذا اليوم من مستخدم آخر منذ فتح شاشة التعديل. أعد فتحها لترى آخر نسخة.', 'conflict');
      const { ids, periods } = cleanAbsence(d, dep, rec, a);
      const old = rec.result;
      const sch = scheduleOf(dep, rec);
      // التكليفات المغطاة في النسخة الحالية، وهل ما زالت حصتها ضمن الغياب المصحح
      const reqKeys = new Set();
      for (const id of ids) for (const e of sch.entries) if (e.teacherId === id && e.day === rec.dayKey && e.type === 'teach' && (!periods[id] || periods[id].includes(e.period))) reqKeys.add(id + '|' + e.period + '|' + String(e.cls == null ? '' : e.cls).trim());
      const marks = a.marks || {};
      const replacements = a.replacements || {};
      const locked = {}; const assignments = []; const manual = {};
      const exList = cleanCorrExclusions(d, dep, rec, a);
      const exAt = (tid, period) => exList.some(x => x.teacherId === tid && (x.scope === 'day' || x.periods.includes(period)));
      const exOld = (rec.exclusions || []).map(x => x.teacherId + ':' + (x.scope === 'periods' ? (x.periods || []).join(',') : 'day')).sort().join('|');
      const exNew = exList.map(x => x.teacherId + ':' + (x.scope === 'periods' ? x.periods.join(',') : 'day')).sort().join('|');
      for (const x of exList) if (ids.includes(x.teacherId)) fail(`«${nameIn(d, x.teacherId)}» مسجل غائبًا؛ لا يحتاج تجاوزًا.`);

      // تعديل معلم الاحتياط من جدول التوزيع في شاشة التصحيح (للحصص غير المنفّذة والباقية ضمن الغياب فقط)
      for (const [k, v] of Object.entries(cleanManual(a.manual))) if (reqKeys.has(k) && v.teacherId) manual[k] = { teacherId: v.teacherId, source: 'rotation', reason: v.reason };
      for (const s0 of old.slots.filter(x => x.status === 'covered')) {
        const key = slotKeyOf(s0); const still = reqKeys.has(key);
        let m = ['done', 'cancel', 'replace'].includes(marks[key]) ? marks[key] : null;
        // معلم الاحتياط صار متجاوزًا لهذا اليوم: تكليفه لم يُنفّذ، ويُعاد توزيع الحصة على التالي بالدين أو الدور
        if (exAt(s0.teacherId, s0.period)) {
          if (m === 'done') fail(`«${s0.teacherName}» متجاوز في الحصة ${s0.period}، ولا يجتمع التجاوز مع «نُفّذ فعليًا». ألغِ تجاوزه أو اختر «لم يُنفّذ / أُلغي».`);
          if (m !== 'replace') m = 'cancel';
        }
        if (!still && !m) fail(`حدّد حالة تكليف «${s0.teacherName}» للحصة ${s0.period} — الصف ${s0.cls}: «نُفّذ فعليًا» أو «لم يُنفّذ / أُلغي».`);
        const mark = m || 'done';
        if (mark === 'done' && (a.transfers || []).includes(key) && !m) fail(`لإحالة الحصة ${s0.period} — الصف ${s0.cls} إلى الإدارة حدّد أولًا أن تكليف «${s0.teacherName}» «لم يُنفّذ / أُلغي».`);
        if (mark === 'done') { locked[key] = { teacherId: s0.teacherId, source: s0.source, kind: s0.kind, period: s0.period, cls: s0.cls, absentId: s0.absentId }; delete manual[key]; }
        let replaceWith = null;
        if (mark === 'replace') {
          // الاستبدال يخص الحصص غير المنفذة: يُلغى أثر التكليف السابق ويُحسب أثر البديل بالقواعد (المصدر تلقائي)
          if (!still) fail(`لا يمكن استبدال معلم الحصة ${s0.period} — الصف ${s0.cls} لأنها لم تعد ضمن الغياب.`);
          replaceWith = replacements[key];
          const t = d.teachers.find(x => x.id === replaceWith && x.deptId === dep.id);
          if (!t) fail(`اختر المعلم البديل للحصة ${s0.period} — الصف ${s0.cls} من معلمي القسم.`);
          if (replaceWith === s0.teacherId) fail(`المعلم البديل للحصة ${s0.period} هو نفسه المعلم الحالي.`);
          if (exAt(replaceWith, s0.period)) fail(`المعلم البديل للحصة ${s0.period} «${t.name}» متجاوز في هذا اليوم.`);
          manual[key] = { teacherId: replaceWith, source: 'rotation', reason: String(a.replaceReason || '').trim() || 'استبدال معلم الاحتياط عند تعديل يوم معتمد (التكليف السابق لم يُنفّذ)' };
        }
        assignments.push({ key, period: s0.period, cls: s0.cls, absentName: s0.absentName, teacherId: s0.teacherId, teacherName: s0.teacherName, source: s0.source, kind: s0.kind, affected: !still, mark, replaceWith });
      }
      const pre = preStateOf(rec);
      // يُصحَّح اليوم بإعداداته وقت اعتماده (اليوم القديم بلا إعدادات = الدين والدور مفعّلان)
      // حد القسم المحفوظ مع اليوم المعتمد هو المطبَّق على تصحيحه (لا يتغير يوم معتمد بصمت بتغيير الإعداد لاحقًا)
      const recSt = rec.settings ? { debt: rec.settings.debt !== false, rotation: rec.settings.rotation !== false, adminTransfer: rec.settings.adminTransfer === true, oneDaily: rec.settings.oneDaily === true, ...capOf(rec.settings), xferRule: rec.settings.xferRule === true } : { debt: true, rotation: true, adminTransfer: false, oneDaily: false, cap: null, xferMax: null, xferRule: false };
      const oldTransfers = old.slots.filter(x => x.status === 'admin').map(slotKeyOf);
      const transfers = cleanTransfers(a.transfers === undefined ? oldTransfers : a.transfers, recSt.adminTransfer || settingsOf(dep).adminTransfer, oldTransfers).filter(k => reqKeys.has(k));
      for (const k of transfers) if (locked[k]) fail('حصة محالة إلى الإدارة لها تكليف مسجل «نُفّذ فعليًا». اختر «لم يُنفّذ / أُلغي» لتكليفها أولًا، أو ألغِ الإحالة.');
      // إحالة أسندتها الإدارة: لا تُلغى ولا تخرج من الغياب دون إلغاء الإسناد أولًا (لا حلقة ولا سجل مكرر)
      for (const k of oldTransfers) {
        const act = aaActive(d, refOf(dep.id, rec.date, k));
        if (act && act.state === 'assigned' && !transfers.includes(k)) { const s0 = old.slots.find(x => slotKeyOf(x) === k) || {}; fail(`الحصة ${s0.period} — الصف ${s0.cls} أسندتها الإدارة إلى «${act.teacherName}» (${act.toDeptName}). ألغِ الإسناد من «الحصص المحالة إلى الإدارة» أولًا قبل إلغاء الإحالة أو تعديل غيابها.`, 'conflict'); }
      }
      { const conf = aaAbsentConflicts(d, dep, rec.date, ids, periods); if (conf.length) fail(conf.join(' '), 'conflict'); }
      for (const k of transfers) delete manual[k];
      const r = Engine.computeDay({
        settings: engineSettings({ ...recSt, adminTransfer: recSt.adminTransfer || settingsOf(dep).adminTransfer }, recSt.xferRule), transfers,
        // تأكيد صريح أن الإحالات السابقة نُفذت فعليًا: تُحفظ كاستثناء تاريخي إن صارت فوق المسموح بعد التصحيح
        capKeep: a.capKeep === true ? oldTransfers.filter(k => transfers.includes(k)) : undefined,
        teachers: teachersOf(d, dep.id).map(t => ({ id: t.id, name: t.name, status: t.status, inRotation: t.inRotation, rotationOrder: t.rotationOrder })),
        headId: dep.headTeacherId, dayKey: rec.dayKey, date: rec.date, schedule: sch,
        absentIds: ids, noAbsence: !ids.length, absentPeriods: periods, locked, manual,
        swaps: cleanSwaps(a.swaps).filter(p => reqKeys.has(p[0]) && reqKeys.has(p[1]) && !['cancel', 'replace'].includes(marks[p[0]]) && !['cancel', 'replace'].includes(marks[p[1]])),
        state: { confirmed: true, ...pre },
        exclusions: exList.map(x => ({ teacherId: x.teacherId, scope: x.scope, periods: x.periods })),
        busy: aaBusy(d, dep.id, rec.date)
      });
      if (!r.ok) fail(r.headline + ' ' + r.missing.join(' '), r.capExceeded ? 'cap' : undefined);
      // الأثر على الحالة الحالية: فرق النسخة الجديدة عن الحالية فقط (لا تُضاف آثار فوق آثار، ولا تُسترجع حالة قديمة)
      const cur = dep.state; const warnings = [];
      // يوم سابق لإعادة ضبط الدين والدور: يُصحَّح سجله فقط، ولا تعود ديونه ولا أثر دوره إلى الدورة الجديدة
      const beforeReset = (rec.epoch || 0) !== (cur.epoch || 0);
      if (beforeReset) warnings.push(`هذا اليوم سابق لإعادة ضبط الدين والدور${cur.resetAt ? ` (${cur.resetAt.slice(0, 10)})` : ''}؛ يُصحَّح سجله ونتائجه فقط، ولا تعود ديونه ولا أثر دوره إلى الدورة الجديدة.`);
      const nm = id => nameIn(d, id);
      const mg = mergeDelta(d, dep, old, r, { debts: !beforeReset, rotation: !beforeReset && !rec.rotationCut });
      warnings.push(...mg.warnings);
      const { debtChanges } = mg; const { pointer, skips, manualNext } = mg.stateAfter;
      const later = d.days.filter(x => x.deptId === dep.id && x.id !== rec.id && (x.date > rec.date || x.approvedAt > rec.approvedAt)).map(x => x.date).sort();
      if (later.length) warnings.push(`توجد أيام معتمدة بعد هذا اليوم (${later.join('، ')}). لن يُعاد توزيعها ولن تتغير نتائجها المحفوظة${beforeReset ? '.' : '؛ يُطبّق فرق الدين والحقوق على الحالة الحالية فقط.'}`);
      if (rec.rotationCut && !beforeReset) warnings.push('أُعيد الدور من البداية بعد الاعتماد الأول لهذا اليوم؛ يُطبّق فرق الدين فقط ولا يُغيَّر الدور.');
      const kept = assignments.filter(x => x.mark === 'done');
      const cancelled = assignments.filter(x => x.mark === 'cancel');
      const replaced = assignments.filter(x => x.mark === 'replace').map(x => {
        const ns = r.slots.find(y => slotKeyOf(y) === x.key) || {};
        return { key: x.key, period: x.period, cls: x.cls, absentName: x.absentName, fromName: x.teacherName, fromSource: x.source, fromKind: x.kind, toName: ns.teacherName, toSource: ns.source, toKind: ns.kind, debtBefore: ns.debtBefore, debtAfter: ns.debtAfter };
      });
      const oldKeys = new Set(old.slots.filter(x => x.status === 'covered').map(x => slotKeyOf(x) + '>' + x.teacherId));
      const replacedKeys = new Set(assignments.filter(x => x.mark === 'replace').map(x => x.key));
      const swapped = r.slots.filter(x => x.swapped && !oldKeys.has(slotKeyOf(x) + '>' + x.teacherId)).map(x => { const o = old.slots.find(y => slotKeyOf(y) === slotKeyOf(x)) || {}; return { key: slotKeyOf(x), period: x.period, cls: x.cls, absentName: x.absentName, fromName: o.teacherName || '—', toName: x.teacherName, source: x.source }; });
      const swappedKeys = new Set(swapped.map(x => x.key));
      const added = r.slots.filter(x => x.status === 'covered' && !oldKeys.has(slotKeyOf(x) + '>' + x.teacherId) && !replacedKeys.has(slotKeyOf(x)) && !swappedKeys.has(slotKeyOf(x))).map(x => ({ period: x.period, cls: x.cls, absentName: x.absentName, teacherName: x.teacherName, source: x.source }));
      const stateAfter = mg.stateAfter;
      const ring = Engine.buildRing(teachersOf(d, dep.id), dep.headTeacherId);
      const tById = new Map(teachersOf(d, dep.id).map(t => [t.id, t]));
      const nxB = Engine.nextPriority(ring, tById, cur.pointer, cur.pending, cur.skips, cur.manualNext, cur.earlyTurns, cur.extraCredits);
      const nxA = Engine.nextPriority(ring, tById, pointer, stateAfter.pending, skips, manualNext, stateAfter.earlyTurns, stateAfter.extraCredits);
      // «الدور القادم» في سجل اليوم (ورسالة القروب) = الدور الفعلي بعد التصحيح، لا ناتج إعادة الحساب وحده (إن لم تأتِ بعده أيام معتمدة)
      if (!later.length && !beforeReset) { r.nextInRotation = nxA.id || null; r.nextInRotationName = nxA.id ? nm(nxA.id) : null; r.nextKind = nxA.kind || null; }
      const absText = res => (res.noAbsence || !(res.absentees || []).length) ? [] : res.absentees.map(x => ({ id: x.id, name: x.name, periods: x.periods, partial: x.partial || null }));
      return {
        result: r, ids, periods, stateAfter, marks: Object.fromEntries(assignments.map(x => [x.key, x.mark])), exclusions: exList,
        preview: {
          exBefore: (rec.exclusions || []).map(x => ({ name: nm(x.teacherId), scope: x.scope, periods: x.periods || [] })), exAfter: exList.map(x => ({ name: nm(x.teacherId), scope: x.scope, periods: x.periods })), exChanged: exOld !== exNew,
          absBefore: absText(old), absAfter: absText(r), slotsBefore: old.slots.length, slotsAfter: r.slots.length,
          kept, cancelled, replaced, added, swapped, uncoveredAfter: r.uncovered.map(x => ({ period: x.period, cls: x.cls, absentName: x.absentName })),
          transferredBefore: oldTransfers.length, transferredAfter: (r.transferred || []).map(x => ({ key: x.key, period: x.period, cls: x.cls, absentName: x.absentName })),
          cap: r.cap, capBefore: old.cap || null,
          settings: recSt,
          debtChanges,
          rotation: {
            pointerBefore: nm(cur.pointer), pointerAfter: nm(pointer),
            nextBefore: nxB.id ? nm(nxB.id) : null, nextAfter: nxA.id ? nm(nxA.id) : null,
            pendingBefore: (cur.pending || []).slice().sort((x, y) => x.seq - y.seq).map(p => nm(p.teacherId)),
            pendingAfter: stateAfter.pending.map(p => nm(p.teacherId)),
            manualNextBefore: cur.manualNext ? nm(cur.manualNext) : null, manualNextAfter: manualNext ? nm(manualNext) : null,
            earlyBefore: (cur.earlyTurns || []).map(nm), earlyAfter: (stateAfter.earlyTurns || []).map(nm),
            creditChanges: creditChangesOf(cur.extraCredits, stateAfter.extraCredits).map(x => ({ ...x, name: nm(x.id) }))
          },
          laterDays: later, warnings, notes: r.notes, beforeReset,
          unchanged: exOld === exNew && !debtChanges.length && !creditChangesOf(cur.extraCredits, stateAfter.extraCredits).length && JSON.stringify(absText(old)) === JSON.stringify(absText(r)) && !cancelled.length && !added.length && !replaced.length && !swapped.length
            && JSON.stringify(oldTransfers.slice().sort()) === JSON.stringify((r.transferred || []).map(x => x.key).sort())
        }
      };
    }
    function creditChangesOf(b0, a0) { const b = cleanCredits(b0), a = cleanCredits(a0); return Array.from(new Set(Object.keys(b).concat(Object.keys(a)))).filter(id => (b[id] || 0) !== (a[id] || 0)).map(id => ({ id, before: b[id] || 0, after: a[id] || 0 })); }
    function correctionTarget(d, ctx, a) {
      const dep = deptIn(d, scope(ctx, a.deptId));
      const rec = d.days.find(x => x.deptId === dep.id && x.date === a.date);
      if (!rec) fail('هذا اليوم غير معتمد؛ عدّل الغياب من صفحة احتياط اليوم قبل الاعتماد.', 'not_found');
      return { dep, rec };
    }
    // بيانات شاشة التعديل: حصص تدريس كل معلم في جدول ذلك اليوم (للاختيار دون إدخال يدوي)
    op('day.correctInfo', ['admin', 'head'], async (ctx, a) => {
      const { dep, rec } = correctionTarget(db, ctx, a);
      const sch = scheduleOf(dep, rec);
      const teach = {};
      for (const e of sch.entries) if (e.day === rec.dayKey && e.type === 'teach') (teach[e.teacherId] = teach[e.teacherId] || []).push({ period: e.period, cls: String(e.cls == null ? '' : e.cls).trim() });
      for (const k in teach) teach[k].sort((x, y) => x.period - y.period);
      const st = settingsOf(dep);
      const recSt = rec.settings ? { ...rec.settings, ...capOf(rec.settings) } : { debt: true, rotation: true, adminTransfer: false, oneDaily: false, cap: null, xferMax: null };
      return { teach, dayVersion: dayVersionOf(rec), stateVersion: dep.state.version, allowTransfer: !!(st.adminTransfer || recSt.adminTransfer || (rec.result.slots || []).some(x => x.status === 'admin')), recSettings: recSt };
    });
    op('day.correctPreview', ['admin', 'head'], async (ctx, a) => {
      const { dep, rec } = correctionTarget(db, ctx, a);
      const p = planCorrection(db, dep, rec, a);
      return { preview: p.preview, result: p.result, stateVersion: dep.state.version, dayVersion: dayVersionOf(rec) };
    });
    op('day.correct', ['admin', 'head'], async (ctx, a) => tx(d => {
      const { dep, rec } = correctionTarget(d, ctx, a);
      requireVersion(dep, a.stateVersion);
      if (a.laterAck !== true && d.days.some(x => x.deptId === dep.id && x.id !== rec.id && (x.date > rec.date || x.approvedAt > rec.approvedAt))) fail('راجع أثر التصحيح على الأيام المعتمدة اللاحقة وأكّد الاطلاع عليه قبل الحفظ.');
      const p = planCorrection(d, dep, rec, a);
      for (const sl of p.result.slots) delete sl.options; // خيارات التعديل لا تُحفظ في السجل
      if (p.preview.unchanged) fail('لا يوجد تغيير في الغياب أو التكليفات؛ لم يُحفظ شيء.');
      const desc = `تصحيح غياب يوم ${rec.date}`;
      const b = takeBackup(d, dep, ctx, 'تصحيح غياب يوم معتمد', desc);
      b.snapshot.dayRecord = structuredClone(rec);
      // إصدارات اليوم: الاعتماد الأول ثم كل تصحيح
      if (!rec.versions) rec.versions = [{ no: 1, kind: 'approve', at: rec.approvedAt, by: rec.approvedBy, role: rec.approvedRole, absentIds: rec.absentIds.slice(), absentPeriods: structuredClone(rec.absentPeriods || {}), noAbsence: rec.noAbsence, result: structuredClone(rec.result), marks: null }];
      const no = rec.versions.length + 1;
      const pv = p.preview;
      rec.versions.push({ no, kind: 'correction', at: iso(), by: ctx.name, role: ctx.role === 'admin' ? 'admin' : ctx.kind, absentIds: p.ids.slice(), absentPeriods: structuredClone(p.periods), noAbsence: !p.ids.length, result: structuredClone(p.result), marks: p.marks,
        exclusions: p.exclusions.map(x => ({ teacherId: x.teacherId, scope: x.scope, periods: x.periods.slice() })),
        summary: { cancelled: pv.cancelled.length, kept: pv.kept.length, added: pv.added.length, replaced: (pv.replaced || []).map(x => ({ period: x.period, cls: x.cls, from: x.fromName, to: x.toName, source: x.toSource })), debtChanges: pv.debtChanges.map(x => ({ name: x.name, before: x.before, after: x.after })) } });
      if (!rec.preState) rec.preState = preStateOf(rec);
      rec.absentIds = p.ids.slice(); rec.absentPeriods = structuredClone(p.periods); rec.noAbsence = !p.ids.length; rec.result = p.result;
      // التجاوزات: سجل اليوم + قائمة التجاوزات المؤقتة للقسم (المضاف يُسجَّل فعّالًا، والمحذوف يُلغى)
      if (pv.exChanged) {
        const was = new Map((rec.exclusions || []).map(x => [x.teacherId, x]));
        const now = new Map(p.exclusions.map(x => [x.teacherId, x]));
        for (const x of activeExclusions(dep, rec.date)) if (!now.has(x.teacherId)) { x.status = 'cancelled'; x.cancelledBy = ctx.name; x.cancelledAt = iso(); }
        for (const x of p.exclusions) {
          const cur = activeExclusions(dep, rec.date).find(y => y.teacherId === x.teacherId);
          if (cur) { cur.scope = x.scope; cur.periods = x.periods.slice(); }
          else dep.exclusions = (dep.exclusions || []).concat([{ id: uid('ex'), teacherId: x.teacherId, date: rec.date, reason: x.reason || 'quick', note: x.note || 'عند تعديل يوم معتمد', scope: x.scope, periods: x.periods.slice(), status: 'active', createdBy: ctx.name, createdRole: ctx.role === 'admin' ? 'admin' : ctx.kind, createdAt: iso() }]);
        }
        rec.exclusions = p.exclusions.map(x => ({ teacherId: x.teacherId, scope: x.scope, periods: x.periods.slice(), reason: x.reason || 'quick', note: x.note || (was.has(x.teacherId) ? '' : 'عند تعديل يوم معتمد') }));
      }
      rec.marks = p.marks; rec.correctedAt = iso(); rec.correctedBy = ctx.name; rec.correctedRole = ctx.role === 'admin' ? 'admin' : ctx.kind;
      const before = stateSnap(dep);
      const sa = p.stateAfter;
      journal(dep, ctx, 'correction', dep.state.debts, sa.debts, rec.date, rec.id);
      creditDiffLog(dep, ctx, dep.state.extraCredits, sa.extraCredits, 'correction', { date: rec.date, dayId: rec.id, note: `تصحيح توزيع يوم ${rec.date}` });
      dep.state = { ...dep.state, debts: sa.debts, pointer: sa.pointer, pending: sa.pending, skips: sa.skips, earlyTurns: sa.earlyTurns || [], extraCredits: cleanCredits(sa.extraCredits), pendingSeq: sa.pendingSeq, manualNext: sa.manualNext };
      bump(dep, b.id);
      const absTxt = list => list.length ? list.map(x => x.partial ? `${x.name} (الحصص ${x.partial.join('، ')})` : x.name).join('، ') : 'لا يوجد غياب';
      const exTxt = l => l.length ? l.map(x => x.scope === 'day' ? x.name : `${x.name} (الحصص ${x.periods.join('، ')})`).join('، ') : 'لا يوجد';
      audit(d, ctx, 'تصحيح غياب يوم معتمد', `${rec.date} — الإصدار ${no}: الغياب ${absTxt(pv.absBefore)} ← ${absTxt(pv.absAfter)}${pv.exChanged ? `؛ تجاوز اليوم: ${exTxt(pv.exBefore)} ← ${exTxt(pv.exAfter)}` : ''}؛ أُلغي ${pv.cancelled.length} تكليف، حُفظ ${pv.kept.length}، جديد ${pv.added.length}، محالة إلى الإدارة ${pv.transferredBefore} ← ${pv.transferredAfter.length}${(pv.replaced || []).length ? `، استُبدل: ${pv.replaced.map(x => `ح${x.period} ${x.fromName} ← ${x.toName} (${x.toSource === 'debt' ? 'الدين' : x.toSource === 'rotation' ? 'الدور' : 'دون دين أو دور'})`).join('، ')}` : ''}`, dep.id, { before, after: stateSnap(dep), date: rec.date });
      return { record: structuredClone(rec), preview: pv };
    }));

    // -- التجاوز المؤقت (يحتفظ بحق الدور) --
    const EX_REASONS = { assignment: 'تكليف', circumstance: 'ظروف اليوم', other: 'سبب آخر' };
    const nameIn = (d, id) => (d.teachers.find(t => t.id === id) || {}).name || '—';
    // لقطة مقروءة للحالة (بالأسماء) تُحفظ في السجل قبل التعديل وبعده
    const stateSnap = dep => {
      const d = db; const nm = id => { const t = d.teachers.find(x => x.id === id); return t ? t.name : '—'; };
      return {
        debts: Object.fromEntries(Object.entries(dep.state.debts || {}).filter(([, v]) => v > 0).map(([k, v]) => [nm(k), v])),
        pointer: dep.state.pointer ? nm(dep.state.pointer) : null,
        pending: (dep.state.pending || []).slice().sort((a, b) => a.seq - b.seq).map(p => nm(p.teacherId)),
        skips: (dep.state.skips || []).map(nm),
        earlyTurns: (dep.state.earlyTurns || []).map(nm),
        extraCredits: Object.fromEntries(Object.entries(cleanCredits(dep.state.extraCredits)).map(([k, v]) => [nm(k), v]))
      };
    };
    // نسخة احتياطية لحالة القسم قبل كل تعديل يدوي، تُحفظ ضمن عملية الحفظ نفسها
    const MAX_BACKUPS = 200;
    function takeBackup(d, dep, ctx, action, description) {
      const snapshot = {
        debts: structuredClone(dep.state.debts || {}), pointer: dep.state.pointer || null,
        pending: structuredClone(dep.state.pending || []), skips: (dep.state.skips || []).slice(), earlyTurns: (dep.state.earlyTurns || []).slice(), extraCredits: cleanCredits(dep.state.extraCredits), pendingSeq: dep.state.pendingSeq || 0,
        manualNext: dep.state.manualNext || null, epoch: dep.state.epoch || 0, resetAt: dep.state.resetAt || null, resetBy: dep.state.resetBy || null, resetJournalLen: dep.state.resetJournalLen == null ? null : dep.state.resetJournalLen,
        order: Object.fromEntries(teachersOf(d, dep.id).map(t => [t.id, t.rotationOrder])),
        exclusions: structuredClone(dep.exclusions || [])
      };
      const b = { id: uid('bk'), at: iso(), actor: ctx.name, role: ctx.role === 'admin' ? 'admin' : ctx.kind, action, description, snapshot, prevChangeId: dep.state.lastChangeId === undefined ? null : dep.state.lastChangeId, undone: false };
      dep.backups = (dep.backups || []).concat([b]).slice(-MAX_BACKUPS);
      return b;
    }
    function undoStatus(d, dep) {
      const b = (dep.backups || []).slice().reverse().find(x => !x.undone);
      if (!b) return { available: false, reason: 'لا يوجد تعديل يدوي للتراجع عنه.' };
      const info = { backupId: b.id, description: b.description, at: b.at, actor: b.actor, role: b.role };
      if (dep.state.lastChangeId === b.id) return { available: true, ...info };
      const after = x => (x.stateVersion != null && b.versionAfter != null ? x.stateVersion >= b.versionAfter : x.approvedAt >= b.at);
      const laterDay = d.days.filter(x => x.deptId === dep.id && after(x)).sort((x, y) => (x.approvedAt < y.approvedAt ? -1 : 1))[0];
      return { available: false, ...info, reason: laterDay
        ? `اعتُمد توزيع يوم ${laterDay.date} بعد هذا التعديل، واستعادة الحالة السابقة فوقه ستعارض نتائجه المحفوظة. لا يُتراجع عنه مباشرة؛ عدّل القيم يدويًا إن لزم.`
        : 'حدث تغيير لاحق على حالة القسم بعد هذا التعديل (مثل تعديل المعلمين أو الجدول أو الحالة الافتتاحية)، فلا يُتراجع عنه مباشرة حتى لا تفسد البيانات.' };
    }

    op('debt.adjust', ['admin', 'head'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId)); needDebt(dep);
      const t = d.teachers.find(x => x.id === a.teacherId && x.deptId === dep.id);
      if (!t) fail('اختر معلمًا من معلمي القسم.');
      const delta = a.delta === 1 ? 1 : a.delta === -1 ? -1 : 0;
      if (!delta) fail('مقدار التعديل غير صالح.');
      const cur = Math.max(0, dep.state.debts[t.id] || 0);
      // مقارنة بالقيمة التي رآها المستخدم: تمنع احتساب الضغطة مرتين وتمنع التعارض بين مستخدمين
      if (a.expected !== cur) fail(`تغيّر رصيد «${t.name}» (القيمة الحالية ${cur}) من تعديل آخر أو توزيع معتمد. حُدّثت القيمة؛ أعد المحاولة إن لزم.`, 'conflict');
      const next = cur + delta;
      if (next < 0) fail('لا يمكن أن يقل الدين عن 0.');
      const desc = `${delta > 0 ? 'زيادة' : 'إنقاص'} دين «${t.name}» من ${cur} إلى ${next}`;
      const b = takeBackup(d, dep, ctx, 'تعديل دين يدوي', desc);
      journal(dep, ctx, 'manual', { [t.id]: cur }, { [t.id]: next }, null, b.id);
      if (next) dep.state.debts[t.id] = next; else delete dep.state.debts[t.id];
      bump(dep, b.id);
      audit(d, ctx, 'تعديل دين يدوي', `${t.name}: ${cur} ← ${next}`, dep.id, { before: { debts: { [t.name]: cur } }, after: { debts: { [t.name]: next } }, teacherId: t.id, delta, backupId: b.id });
      return { value: next, version: dep.state.version };
    }));
    /* رصيد الحصص الإضافية: + لإضافة حصة مسكها المعلم إضافيًا (بملاحظة)، − للتصحيح. لا يقل عن 0، ولا يحرك مؤشر الدور،
       ولا يمس الدين، ولا ينشئ حصة أو غيابًا في السجل. يُستخدم عند وصول الدور إلى صاحبه. يلزم الدور مفعّلًا. */
    /* خانة الدين الموحّدة (دين − حصص زيادة): القيمة الظاهرة = الدين، أو بالسالب عدد الحصص الزيادة.
       «−»: يسدّد دينًا إن وُجد، وإلا يسجّل حصة زيادة (شال حصة إضافية) فتصبح القيمة سالبة.
       «+»: يلغي حصة زيادة إن وُجدت، وإلا يزيد الدين. لا يجتمع دين وحصص زيادة لنفس المعلم. */
    op('balance.adjust', ['admin', 'head'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId));
      const t = d.teachers.find(x => x.id === a.teacherId && x.deptId === dep.id);
      if (!t) fail('اختر معلمًا من معلمي القسم.');
      const delta = a.delta === 1 ? 1 : a.delta === -1 ? -1 : 0;
      if (!delta) fail('مقدار التعديل غير صالح.');
      const debt = Math.max(0, dep.state.debts[t.id] || 0); const cr = cleanCredits(dep.state.extraCredits); const credit = cr[t.id] || 0;
      const cur = debt - credit;
      if (a.expected !== cur) fail(`تغيّرت قيمة «${t.name}» (الحالية ${cur}) من تعديل آخر أو توزيع معتمد. حُدّثت القيمة؛ أعد المحاولة إن لزم.`, 'conflict');
      const next = cur + delta;
      const st = settingsOf(dep);
      const useCredit = delta < 0 ? debt === 0 : credit > 0; // − بلا دين = حصة زيادة؛ + مع حصص زيادة = إلغاء واحدة
      if (useCredit) {
        if (delta < 0) {
          if (!st.rotation) fail('الدور غير مفعّل لهذا القسم؛ لا تُسجَّل حصص زيادة (قيمة سالبة).', 'disabled');
          if (!ringOf(d, dep).includes(t.id) || t.status !== 'active') fail('الحصص الزيادة لمعلم فعّال ضمن ترتيب الدور (رئيس القسم خارج الدور).');
          if ((dep.state.earlyTurns || []).includes(t.id) && a.earlyAck !== true) fail(`«${t.name}» لديه دور مبكر مسجل بالنظام (أخذ احتياطًا بالدور قبل موعده)، وسيُعفى منه تلقائيًا عند وصول دوره. لا تسجّل حصة زيادة لنفس الحصة؛ أكّد فقط إن كانت حصة أخرى لم يسجلها النظام.`, 'early_ack');
        }
      } else needDebt(dep);
      const note = String(a.note || '').trim().slice(0, 120);
      const shw = v => (v < 0 ? '+' + (-v) : v > 0 ? '−' + v : '0'); // نفس عرض جدول الدين: الزيادة موجبة والدين سالب
      const desc = `«${t.name}»: ${shw(cur)} ← ${shw(next)}${useCredit ? (delta < 0 ? ' (شال حصة زيادة)' : ' (إلغاء حصة زيادة)') : (delta < 0 ? ' (إنقاص دين)' : ' (زيادة دين)')}`;
      const b = takeBackup(d, dep, ctx, useCredit ? 'تعديل رصيد إضافي' : 'تعديل دين يدوي', desc);
      if (useCredit) {
        const v = credit - delta; if (v) cr[t.id] = v; else delete cr[t.id];
        dep.state.extraCredits = cr;
        creditLogAdd(dep, ctx, { kind: delta < 0 ? 'add' : 'fix', teacherId: t.id, delta: -delta, before: credit, after: v, note: note || (delta < 0 ? 'شال حصة زيادة' : 'تصحيح'), backupId: b.id });
        audit(d, ctx, 'تعديل رصيد إضافي', `${t.name}: ${cur} ← ${next}`, dep.id, { teacherId: t.id, delta, backupId: b.id });
      } else {
        journal(dep, ctx, 'manual', { [t.id]: debt }, { [t.id]: debt + delta }, null, b.id);
        if (debt + delta) dep.state.debts[t.id] = debt + delta; else delete dep.state.debts[t.id];
        audit(d, ctx, 'تعديل دين يدوي', `${t.name}: ${debt} ← ${debt + delta}`, dep.id, { before: { debts: { [t.name]: debt } }, after: { debts: { [t.name]: debt + delta } }, teacherId: t.id, delta, backupId: b.id });
      }
      bump(dep, b.id);
      return { value: next, version: dep.state.version };
    }));
    op('credit.adjust', ['admin', 'head'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId)); needRotation(dep);
      const t = d.teachers.find(x => x.id === a.teacherId && x.deptId === dep.id);
      if (!t) fail('اختر معلمًا من معلمي القسم.');
      if (!ringOf(d, dep).includes(t.id) || t.status !== 'active') fail('الرصيد الإضافي لمعلم فعّال ضمن ترتيب الدور (رئيس القسم خارج الدور).');
      const delta = a.delta === 1 ? 1 : a.delta === -1 ? -1 : 0;
      if (!delta) fail('مقدار التعديل غير صالح.');
      const cr = cleanCredits(dep.state.extraCredits); const cur = cr[t.id] || 0;
      // مقارنة بالقيمة التي رآها المستخدم: تمنع احتساب الضغطة مرتين والتعارض بين مستخدمين
      if (a.expected !== cur) fail(`تغيّر رصيد «${t.name}» الإضافي (القيمة الحالية ${cur}) من تعديل آخر أو توزيع معتمد. حُدّثت القيمة؛ أعد المحاولة إن لزم.`, 'conflict');
      const next = cur + delta;
      if (next < 0) fail('لا يمكن أن يقل الرصيد الإضافي عن 0.');
      const note = String(a.note || '').trim().slice(0, 120);
      // دور مبكر مسجل بالنظام لنفس المعلم: إعفاء قائم مقابل حصة سابقة؛ لا يُضاف رصيد للحصة نفسها مرتين
      if (delta > 0 && (dep.state.earlyTurns || []).includes(t.id) && a.earlyAck !== true) fail(`«${t.name}» لديه دور مبكر مسجل بالنظام (أخذ احتياطًا بالدور قبل موعده)، وسيُعفى منه تلقائيًا عند وصول دوره. لا تضف رصيدًا لنفس الحصة؛ أضفه فقط لحصة إضافية أخرى لم تُسجَّل في النظام.`, 'early_ack');
      const desc = `${delta > 0 ? 'إضافة' : 'تصحيح'} رصيد «${t.name}» الإضافي من ${cur} إلى ${next}${note ? ' — ' + note : ''}`;
      const b = takeBackup(d, dep, ctx, 'تعديل رصيد إضافي', desc);
      if (next) cr[t.id] = next; else delete cr[t.id];
      dep.state.extraCredits = cr;
      creditLogAdd(dep, ctx, { kind: delta > 0 ? 'add' : 'fix', teacherId: t.id, delta, before: cur, after: next, note, backupId: b.id });
      bump(dep, b.id);
      audit(d, ctx, 'تعديل رصيد إضافي', `${t.name}: ${cur} ← ${next}${note ? ' — ' + note : ''}`, dep.id, { teacherId: t.id, delta, backupId: b.id });
      return { value: next, version: dep.state.version };
    }));
    op('rotation.setManualNext', ['admin', 'head'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId)); needRotation(dep); requireVersion(dep, a.stateVersion);
      const tid = a.teacherId || null;
      const ring = Engine.buildRing(teachersOf(d, dep.id), dep.headTeacherId);
      if (tid) { const t = d.teachers.find(x => x.id === tid && x.deptId === dep.id); if (!t || !ring.includes(tid) || t.status !== 'active') fail('اختر معلمًا فعّالًا من ترتيب الدور (رئيس القسم خارج الدور).'); }
      if (tid === (dep.state.manualNext || null)) return { ok: true, unchanged: true };
      const before = stateSnap(dep);
      const desc = tid ? `تحديد الدور يدويًا على «${nameIn(d, tid)}»` : `إلغاء الدور المحدد يدويًا («${nameIn(d, dep.state.manualNext)}»)`;
      const b = takeBackup(d, dep, ctx, 'تحديد الدور يدويًا', desc);
      dep.state.manualNext = tid;
      if (tid) dep.state.skips = (dep.state.skips || []).filter(x => x !== tid);
      bump(dep, b.id);
      audit(d, ctx, 'تحديد الدور يدويًا', desc + ' — حسب التوفر وبعد أولوية الدين', dep.id, { before, after: stateSnap(dep), teacherId: tid || dep.state.manualNext || null });
      return { ok: true };
    }));
    // مفتاح «تجاوز اليوم»: يوم كامل، دون سبب إلزامي
    op('exclusion.toggle', ['admin', 'head'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId)); requireVersion(dep, a.stateVersion);
      const t = d.teachers.find(x => x.id === a.teacherId && x.deptId === dep.id);
      if (!t) fail('اختر معلمًا من معلمي القسم.');
      const date = String(a.date || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('حدّد التاريخ.');
      if (d.days.some(x => x.deptId === dep.id && x.date === date)) fail('اعتُمد توزيع هذا اليوم؛ لا يُعدَّل التجاوز بعده.');
      const cur = (dep.exclusions || []).find(x => x.status === 'active' && x.teacherId === t.id && x.date === date);
      if (!!a.on === !!cur) return { ok: true, unchanged: true };
      if (a.on) {
        if (t.status !== 'active') fail('المعلم غير فعّال.');
        if (t.id === dep.headTeacherId) fail('رئيس القسم معفي من الاحتياط أصلًا.');
        if (d.days.some(x => x.deptId === dep.id && x.date > date)) fail('يوجد يوم معتمد بتاريخ لاحق؛ لا يُسجَّل تجاوز لتاريخ سابق.');
      }
      const desc = `${a.on ? 'تفعيل' : 'إلغاء'} تجاوز اليوم لـ«${t.name}» — ${date}`;
      const b = takeBackup(d, dep, ctx, 'تجاوز اليوم', desc);
      if (a.on) dep.exclusions = (dep.exclusions || []).concat([{ id: uid('ex'), teacherId: t.id, date, reason: 'quick', note: '', scope: 'day', periods: [], status: 'active', createdBy: ctx.name, createdRole: ctx.role === 'admin' ? 'admin' : ctx.kind, createdAt: iso() }]);
      else { cur.status = 'cancelled'; cur.cancelledBy = ctx.name; cur.cancelledAt = iso(); }
      bump(dep, b.id);
      audit(d, ctx, a.on ? 'تجاوز مؤقت — يحتفظ بحق الدور' : 'إلغاء تجاوز مؤقت', `${t.name} — ${date} — اليوم كاملًا`, dep.id, { date, scope: 'day', teacherId: t.id });
      return { ok: true };
    }));
    op('exclusion.note', ['admin', 'head'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId)); requireVersion(dep, a.stateVersion);
      const x = (dep.exclusions || []).find(e => e.id === a.id && e.status === 'active'); if (!x) fail('التجاوز غير موجود.', 'not_found');
      const note = String(a.note || '').trim().slice(0, 300);
      if (note === (x.note || '')) return { ok: true, unchanged: true };
      const b = takeBackup(d, dep, ctx, 'ملاحظة تجاوز', `ملاحظة على تجاوز «${nameIn(d, x.teacherId)}» — ${x.date}`);
      x.note = note; bump(dep, b.id);
      audit(d, ctx, 'ملاحظة على تجاوز مؤقت', `${nameIn(d, x.teacherId)} — ${x.date}`, dep.id);
      return { ok: true };
    }));
    op('state.undo', ['admin', 'head'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId));
      const st = undoStatus(d, dep);
      if (st.backupId && a.backupId !== st.backupId) fail('تغيّر آخر تعديل منذ فتح الصفحة. حدّث الصفحة وراجع ما سيُتراجع عنه.', 'conflict');
      if (!st.available) fail(st.reason, 'conflict');
      const b = dep.backups.find(x => x.id === st.backupId);
      const before = stateSnap(dep);
      const sn = b.snapshot;
      journal(dep, ctx, 'undo', dep.state.debts, sn.debts, sn.dayRecord ? sn.dayRecord.date : null, b.id);
      dep.state.debts = structuredClone(sn.debts); dep.state.pointer = sn.pointer; dep.state.pending = structuredClone(sn.pending);
      dep.state.skips = sn.skips.slice(); dep.state.pendingSeq = sn.pendingSeq; dep.state.manualNext = sn.manualNext;
      if (sn.earlyTurns) dep.state.earlyTurns = sn.earlyTurns.slice();
      if (sn.extraCredits) { creditDiffLog(dep, ctx, dep.state.extraCredits, sn.extraCredits, 'undo', { note: 'تراجع: ' + b.description }); dep.state.extraCredits = cleanCredits(sn.extraCredits); }
      if (sn.epoch !== undefined) { dep.state.epoch = sn.epoch; dep.state.resetAt = sn.resetAt; dep.state.resetBy = sn.resetBy; dep.state.resetJournalLen = sn.resetJournalLen == null ? null : sn.resetJournalLen; }
      for (const t of teachersOf(d, dep.id)) if (sn.order[t.id] != null) t.rotationOrder = sn.order[t.id];
      dep.exclusions = structuredClone(sn.exclusions);
      if (sn.dayRecord) { const i = d.days.findIndex(x => x.id === sn.dayRecord.id); if (i >= 0) d.days[i] = structuredClone(sn.dayRecord); }
      if (sn.clearedLedgerReset) dep.clearedLedger = structuredClone(sn.clearedLedgerReset);
      if (sn.clearedDays) {
        // استعادة سجل الغياب الممسوح كما كان (لا يُعاد تطبيق آثاره؛ الحالة تُستعاد من النسخة نفسها)
        const have = new Set(d.days.map(x => x.id));
        for (const rec of sn.clearedDays) if (!have.has(rec.id)) d.days.push(structuredClone(rec));
        dep.clearedLedger = structuredClone(sn.clearedLedger || []);
      }
      b.undone = true; b.undoneAt = iso(); b.undoneBy = ctx.name;
      bump(dep, b.prevChangeId);
      audit(d, ctx, 'تراجع عن آخر تعديل', b.description, dep.id, { before, after: stateSnap(dep) });
      return { ok: true, description: b.description };
    }));

    op('exclusion.add', ['admin', 'head'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId)); requireVersion(dep, a.stateVersion);
      const t = d.teachers.find(x => x.id === a.teacherId && x.deptId === dep.id);
      if (!t) fail('اختر معلمًا من معلمي القسم.');
      if (t.status !== 'active') fail('المعلم غير فعّال.');
      if (t.id === dep.headTeacherId) fail('رئيس القسم معفي من الاحتياط أصلًا؛ لا يحتاج تجاوزًا.');
      const date = String(a.date || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('حدّد التاريخ.');
      if (d.days.some(x => x.deptId === dep.id && x.date === date)) fail('هذا اليوم معتمد مسبقًا؛ لا يُعدَّل توزيعه.');
      if (d.days.some(x => x.deptId === dep.id && x.date > date)) fail('يوجد يوم معتمد بتاريخ لاحق؛ لا يُسجَّل تجاوز لتاريخ سابق.');
      if (!EX_REASONS[a.reason]) fail('اختر سبب التجاوز.');
      const scopeV = a.scope === 'periods' ? 'periods' : 'day';
      let periods = [];
      if (scopeV === 'periods') {
        const dk = Engine.dayKeyOf(date); const sch = schedAt(dep, date);
        const valid = sch && sch.periodsByDay[dk] ? sch.periodsByDay[dk] : [];
        periods = Array.from(new Set((a.periods || []).map(Number))).filter(p => valid.includes(p)).sort((x, y) => x - y);
        if (!periods.length) fail('اختر حصة واحدة على الأقل من حصص هذا اليوم في الجدول المعتمد.');
      }
      if ((dep.exclusions || []).some(x => x.status === 'active' && x.teacherId === t.id && x.date === date)) fail('يوجد تجاوز مؤقت لهذا المعلم في هذا التاريخ. ألغه أولًا ثم سجّل الجديد.', 'conflict');
      const x = { id: uid('ex'), teacherId: t.id, date, reason: a.reason, note: String(a.note || '').trim().slice(0, 300), scope: scopeV, periods, status: 'active', createdBy: ctx.name, createdRole: ctx.role === 'admin' ? 'admin' : ctx.kind, createdAt: iso() };
      const bk = takeBackup(d, dep, ctx, 'تجاوز مؤقت', `تجاوز مؤقت لـ«${t.name}» — ${date} — ${scopeV === 'day' ? 'اليوم كاملًا' : 'الحصص ' + periods.join('، ')}`);
      dep.exclusions = (dep.exclusions || []).concat([x]); bump(dep, bk.id);
      audit(d, ctx, 'تجاوز مؤقت — يحتفظ بحق الدور', `${t.name} — ${date} — ${scopeV === 'day' ? 'اليوم كاملًا' : 'الحصص ' + periods.join('، ')} — ${EX_REASONS[a.reason]}${x.note ? ': ' + x.note : ''}`, dep.id, { date, scope: scopeV === 'day' ? 'day' : periods.join(','), reason: EX_REASONS[a.reason], teacherId: t.id });
      return { id: x.id };
    }));
    op('exclusion.cancel', ['admin', 'head'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId)); requireVersion(dep, a.stateVersion);
      const x = (dep.exclusions || []).find(e => e.id === a.id); if (!x) fail('التجاوز غير موجود.', 'not_found');
      if (x.status !== 'active') fail('التجاوز ليس فعّالًا.');
      if (d.days.some(y => y.deptId === dep.id && y.date === x.date)) fail('اعتُمد توزيع هذا اليوم؛ لا يُلغى التجاوز بعده.');
      const bk = takeBackup(d, dep, ctx, 'إلغاء تجاوز', `إلغاء تجاوز «${nameIn(d, x.teacherId)}» — ${x.date}`);
      x.status = 'cancelled'; x.cancelledBy = ctx.name; x.cancelledAt = iso(); bump(dep, bk.id);
      audit(d, ctx, 'إلغاء تجاوز مؤقت', `${nameIn(d, x.teacherId)} — ${x.date}`, dep.id, { date: x.date, teacherId: x.teacherId });
      return { ok: true };
    }));

    // -- إدارة الدور --
    function ringOf(d, dep) { return Engine.buildRing(teachersOf(d, dep.id), dep.headTeacherId); }
    op('rotation.setOrder', ['admin', 'head'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId)); needRotation(dep); requireVersion(dep, a.stateVersion);
      const ts = teachersOf(d, dep.id);
      const order = Array.isArray(a.order) ? a.order : [];
      if (order.length !== ts.length || new Set(order).size !== order.length || order.some(id => !ts.some(t => t.id === id))) fail('الترتيب يجب أن يشمل معلمي القسم كلهم مرة واحدة.');
      const before = ringOf(d, dep).map(id => nameIn(d, id));
      const bk = takeBackup(d, dep, ctx, 'تعديل ترتيب الدور', 'تعديل ترتيب الدور');
      order.forEach((id, i) => { ts.find(t => t.id === id).rotationOrder = i + 1; });
      const after = ringOf(d, dep).map(id => nameIn(d, id));
      if (before.join() === after.join()) { dep.backups.pop(); return { ok: true, unchanged: true }; }
      bk.description = `تعديل ترتيب الدور إلى: ${after.join('، ')}`;
      bump(dep, bk.id);
      audit(d, ctx, 'إدارة الدور: تعديل الترتيب', `قبل: ${before.join('، ')} — بعد: ${after.join('، ')}`, dep.id, { before: { order: before }, after: { order: after } });
      return { ok: true };
    }));
    op('rotation.setStart', ['admin', 'head'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId)); needRotation(dep); requireVersion(dep, a.stateVersion);
      const ring = ringOf(d, dep);
      const t = d.teachers.find(x => x.id === a.teacherId && x.deptId === dep.id);
      if (!t || !ring.includes(t.id) || t.status !== 'active') fail('اختر معلمًا فعّالًا من ترتيب الدور (رئيس القسم خارج الدور).');
      const pend = dep.state.pending || [];
      const cancel = Array.isArray(a.cancelPending) ? a.cancelPending : [];
      if (pend.length && a.pendingDecision !== 'keep' && a.pendingDecision !== 'cancel') fail('توجد حقوق دور معلقة؛ حدّد أثر التعديل عليها: الاحتفاظ بها أو إلغاء حقوق محددة.');
      if (a.pendingDecision === 'cancel' && !cancel.length) fail('حدّد الحقوق المعلقة التي تريد إلغاءها.');
      const before = stateSnap(dep);
      const bk = takeBackup(d, dep, ctx, 'بدء الدور من معلم', `بدء الدور من «${t.name}»`);
      const i = ring.indexOf(t.id);
      dep.state.pointer = ring.length > 1 ? ring[(i - 1 + ring.length) % ring.length] : t.id;
      if (ring.length === 1) dep.state.pointer = t.id;
      dep.state.skips = (dep.state.skips || []).filter(id => id !== t.id);
      if (a.pendingDecision === 'cancel') dep.state.pending = pend.filter(p => !cancel.includes(p.teacherId));
      if (dep.state.manualNext) dep.state.manualNext = null; // بدء الدور من معلم يحل محل التحديد اليدوي السابق
      bump(dep, bk.id);
      const cancelled = a.pendingDecision === 'cancel' ? cancel.map(id => nameIn(d, id)) : [];
      audit(d, ctx, 'إدارة الدور: بدء الدور من معلم محدد', `يبدأ مسار الدور القادم من ${t.name}${pend.length ? (cancelled.length ? ` — أُلغيت حقوق: ${cancelled.join('، ')}` : ' — الحقوق المعلقة محفوظة بأولويتها') : ''}${a.reason ? ' — السبب: ' + String(a.reason).slice(0, 200) : ''}`, dep.id, { teacherId: t.id, before, after: stateSnap(dep), reason: String(a.reason || '').slice(0, 200) });
      return { ok: true };
    }));
    op('rotation.skip', ['admin', 'head'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId)); needRotation(dep); requireVersion(dep, a.stateVersion);
      const ring = ringOf(d, dep);
      const t = d.teachers.find(x => x.id === a.teacherId && x.deptId === dep.id);
      if (!t || !ring.includes(t.id) || t.status !== 'active') fail('اختر معلمًا فعّالًا من ترتيب الدور.');
      if ((dep.state.skips || []).includes(t.id)) fail('دور هذا المعلم مسجل للتخطي مسبقًا.');
      const before = stateSnap(dep);
      const bk = takeBackup(d, dep, ctx, 'تخطي نهائي', `تخطي دور «${t.name}» نهائيًا لهذه المرة`);
      dep.state.skips = (dep.state.skips || []).concat([t.id]);
      if (dep.state.manualNext === t.id) dep.state.manualNext = null;
      const hadPending = (dep.state.pending || []).some(p => p.teacherId === t.id);
      if (a.cancelPending && hadPending) dep.state.pending = dep.state.pending.filter(p => p.teacherId !== t.id);
      bump(dep, bk.id);
      audit(d, ctx, 'تخطي نهائي لهذه المرة — دون حفظ حق الدور', `${t.name}${hadPending ? (a.cancelPending ? ' — أُلغي حقه المعلّق' : ' — حقه المعلّق محفوظ') : ''}${a.reason ? ' — السبب: ' + String(a.reason).slice(0, 200) : ''}`, dep.id, { teacherId: t.id, before, after: stateSnap(dep), reason: String(a.reason || '').slice(0, 200) });
      return { ok: true };
    }));
    op('rotation.unskip', ['admin', 'head'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId)); needRotation(dep); requireVersion(dep, a.stateVersion);
      if (!(dep.state.skips || []).includes(a.teacherId)) fail('لا يوجد تخطٍّ مسجل لهذا المعلم.');
      const before = stateSnap(dep);
      const bk = takeBackup(d, dep, ctx, 'إلغاء تخطٍّ', `إلغاء تخطي «${nameIn(d, a.teacherId)}»`);
      dep.state.skips = dep.state.skips.filter(id => id !== a.teacherId); bump(dep, bk.id);
      audit(d, ctx, 'إلغاء تخطٍّ مسجل', nameIn(d, a.teacherId), dep.id, { teacherId: a.teacherId, before, after: stateSnap(dep) });
      return { ok: true };
    }));
    // فحص الأرصدة بعد آخر إعادة ضبط: كل رصيد يجب أن تفسّره حركات مسجلة بعدها (توزيع، تصحيح، تعديل يدوي، تراجع)
    function resetCheck(dep) {
      const at = dep.state.resetAt; if (!at) return null;
      // يُعرف موضع إعادة الضبط في الدفتر (يسجَّل وقت الضبط)؛ ضبط أقدم من الدفتر لا يمكن فحصه دون اختلاق
      const idx = dep.state.resetJournalLen;
      if (idx == null) return { resetAt: at, verifiable: false, leftover: [] };
      const after = (dep.debtJournal || []).slice(idx);
      const ts = teachersOf(db, dep.id);
      const leftover = [];
      for (const t of ts) {
        const bal = Math.max(0, (dep.state.debts || {})[t.id] || 0);
        const explained = after.filter(x => x.teacherId === t.id).reduce((sum, x) => sum + x.delta, 0);
        if (bal !== Math.max(0, explained)) leftover.push({ teacherId: t.id, name: t.name, debt: bal, explained: Math.max(0, explained) });
      }
      return { resetAt: at, verifiable: true, leftover };
    }
    function verifyReset(deptId, part = 'all') {
      let saved; try { saved = persistent ? JSON.parse(storage.load()) : db; } catch (e) { return { ok: false, problems: ['تعذّرت قراءة البيانات المحفوظة'], checked: 0 }; }
      const dep = (saved.departments || []).find(x => x.id === deptId);
      const problems = [];
      if (!dep) return { ok: false, problems: ['القسم غير موجود في البيانات المحفوظة'], checked: 0 };
      const ts = (saved.teachers || []).filter(t => t.deptId === deptId);
      if (part !== 'rotation') {
        for (const t of ts) if ((dep.state.debts || {})[t.id] > 0) problems.push(`بقي دين «${t.name}» = ${dep.state.debts[t.id]}`);
        for (const [id, val] of Object.entries(dep.state.debts || {})) if (val > 0 && !ts.some(t => t.id === id)) problems.push('بقي رصيد لمعرّف معلم غير موجود');
      }
      if (Object.values(dep.state.extraCredits || {}).some(v => v > 0)) problems.push('بقي رصيد إضافي');
      if (part === 'debt') return { ok: !problems.length, problems, checked: ts.length };
      if (dep.state.pointer) problems.push('بقيت نقطة الدور');
      if ((dep.state.pending || []).length) problems.push('بقيت حقوق معلقة');
      if ((dep.state.skips || []).length) problems.push('بقي تخطٍّ مسجل');
      if ((dep.state.earlyTurns || []).length) problems.push('بقيت أدوار مأخوذة مبكرًا');
      if (dep.state.manualNext) problems.push('بقي اختيار يدوي للدور');
      return { ok: !problems.length, problems, checked: ts.length };
    }
    // إعادة ضبط الدين والدور: بداية دورة جديدة فعلية للقسم المحدد فقط
    op('rotation.reset', ['admin', 'head'], async (ctx, a) => { const out = await tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId)); requireVersion(dep, a.stateVersion);
      if (a.confirm !== true || a.deptName !== dep.name) fail('أكّد إعادة الضبط لهذا القسم صراحة.');
      // إعادة الضبط الشاملة تتطلب تفعيل الدين والدور معًا؛ وإلا يُعاد ضبط الجزء المفعّل وحده بطلب صريح
      const st = settingsOf(dep);
      const part = a.part === 'debt' || a.part === 'rotation' ? a.part : 'all';
      if (part === 'all' && !(st.debt && st.rotation)) fail(`إعادة الضبط الشاملة معطّلة لأن ${!st.debt ? 'جدول الدين' : 'الدور'} غير مفعّل لهذا القسم. أعد ضبط الجزء المفعّل وحده.`, 'disabled');
      if (part === 'debt') needDebt(dep);
      if (part === 'rotation') needRotation(dep);
      const LBL = { all: 'إعادة ضبط الدين والدور', debt: 'إعادة ضبط الدين فقط', rotation: 'إعادة ضبط الدور فقط' }[part];
      const before = stateSnap(dep);
      const bk = takeBackup(d, dep, ctx, LBL, `${LBL} — ${dep.name}`);
      const approved = new Set(d.days.filter(x => x.deptId === dep.id).map(x => x.date));
      // كل تجاوز مؤقت فعّال لم يُطبَّق في يوم معتمد يُلغى (الماضي والحاضر والمستقبل)؛ ما طُبّق في أيام معتمدة يبقى تاريخًا
      let cancelled = 0;
      if (part !== 'debt') for (const x of dep.exclusions || []) if (x.status === 'active' && !approved.has(x.date)) { x.status = 'cancelled'; x.cancelledBy = ctx.name; x.cancelledAt = iso(); x.cancelReason = 'إعادة ضبط'; cancelled++; }
      // الديون 0 للجميع، ولا مؤشر، ولا حقوق، ولا تخطٍّ، ولا اختيار يدوي؛ وحقبة جديدة تفصل الأيام السابقة عن الدورة الجديدة
      if (part !== 'rotation') journal(dep, ctx, 'reset', dep.state.debts, {}, null, bk.id);
      // بعد «إعادة ضبط الدين والدور» لا مرجع لحركات أيام ممسوحة سابقًا: إعادة تسجيلها حركة جديدة في الدورة الجديدة
      bk.snapshot.clearedLedgerReset = structuredClone(dep.clearedLedger || []);
      dep.clearedLedger = [];
      const rotClear = { pointer: null, pending: [], skips: [], earlyTurns: [], extraCredits: {}, pendingSeq: 0, manualNext: null };
      // الرصيد الإضافي يُصفَّر مع الدور (يبدأ الدور من البداية دون إعفاءات قديمة)، ويبقى سجله التاريخي
      creditDiffLog(dep, ctx, dep.state.extraCredits, {}, 'reset', { note: LBL });
      dep.state = { ...dep.state, confirmed: true, ...(part !== 'rotation' ? { debts: {} } : {}), ...(part !== 'debt' ? rotClear : {}), extraCredits: {}, epoch: (dep.state.epoch || 0) + 1, resetAt: iso(), resetBy: ctx.name, resetPart: part, resetJournalLen: part === 'rotation' ? dep.state.resetJournalLen : (dep.debtJournal || []).length };
      bump(dep, bk.id);
      const ts = teachersOf(d, dep.id);
      const ring = Engine.buildRing(ts, dep.headTeacherId);
      const nx = Engine.nextPriority(ring, new Map(ts.map(t => [t.id, t])), null, [], [], null);
      const what = part === 'all' ? `ديون جميع المعلمين 0، مسح مؤشر الدور والحقوق المعلقة والتخطي والدور المحدد يدويًا وتصفير الرصيد الإضافي، إلغاء ${cancelled} تجاوز مؤقت`
        : part === 'debt' ? 'ديون جميع المعلمين 0 والحصص الزيادة 0 (الدور كما هو)' : `مسح مؤشر الدور والحقوق المعلقة والتخطي والدور المحدد يدويًا وتصفير الرصيد الإضافي، إلغاء ${cancelled} تجاوز مؤقت (الدين كما هو)`;
      audit(d, ctx, LBL, `${dep.name}: ${what}. الدور القادم: ${nx.id ? nameIn(d, nx.id) : 'لا يوجد معلم مؤهل'}. لم تُمس الأيام المعتمدة ولا الجدول ولا الترتيب ولا الحسابات.`, dep.id, { before, after: stateSnap(dep), part });
      // تحقق داخل العملية: لا رصيد متبقٍّ لأي معلم في القسم (ومنهم المؤرشفون وغير الظاهرين)
      if (part !== 'rotation' && Object.values(dep.state.debts).some(v => v > 0)) fail('تعذّر تصفير جميع الأرصدة؛ لم يُحفظ أي تغيير.');
      return { ok: true, deptId: dep.id, part, cancelledExclusions: cancelled, next: nx.id, nextName: nx.id ? nameIn(d, nx.id) : null };
    });
    // تحقق بعد الحفظ: إعادة القراءة من مصدر الحفظ الفعلي، ولا نجاح قبل أن يكون كل رصيد = 0 والدور من البداية
    const v = verifyReset(out.deptId, out.part);
    if (!v.ok) throw new ApiError('حُفظت إعادة الضبط لكن التحقق من البيانات المحفوظة فشل: ' + v.problems.join('، ') + '. أعد تنفيذ إعادة الضبط.', 'verify_failed');
    return { ...out, verified: true, checkedTeachers: v.checked };
    });

    // إعادة ضبط سجل الغياب: مسح الأيام المعتمدة من السجل الفعّال للقسم، دون تغيير أرصدة الدين
    op('log.reset', ['admin', 'head'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId)); requireVersion(dep, a.stateVersion);
      if (a.mode !== 'log' && a.mode !== 'logRotation') fail('اختر أحد خياري إعادة الضبط.');
      if (a.mode === 'logRotation') needRotation(dep);
      if (a.confirm !== true || a.deptName !== dep.name) fail('أكّد إعادة ضبط سجل الغياب لهذا القسم صراحة.');
      const recs = d.days.filter(x => x.deptId === dep.id);
      if (a.expectedCount !== recs.length) fail('تغيّر عدد الأيام في السجل منذ فتح النافذة. حدّث الصفحة وراجع العدد.', 'conflict');
      if (aaList(d).some(x => x.state === 'assigned' && x.srcDeptId === dep.id)) fail('توجد حصص محالة من هذا القسم أسندتها الإدارة. ألغِ إسنادها من «الحصص المحالة إلى الإدارة» قبل مسح السجل، حتى لا يبقى تكليف بلا إحالة.', 'conflict');
      if (!recs.length && a.mode === 'log') fail('لا توجد أيام في سجل الغياب لهذا القسم.');
      const label = a.mode === 'log' ? 'مسح السجل فقط' : 'مسح السجل وإعادة الدور من البداية';
      const before = stateSnap(dep);
      const bk = takeBackup(d, dep, ctx, 'إعادة ضبط سجل الغياب', `إعادة ضبط سجل الغياب (${label}) — ${recs.length} يوم`);
      bk.snapshot.clearedDays = structuredClone(recs);
      bk.snapshot.clearedLedger = structuredClone(dep.clearedLedger || []);
      // مرجع داخلي لحركات الأيام الممسوحة: لا يظهر في السجل، ويمنع مضاعفة الدين والدور عند إعادة تسجيل التاريخ نفسه
      const ledger = (dep.clearedLedger || []).filter(x => !recs.some(r0 => r0.date === x.date));
      for (const r0 of recs) ledger.push({ date: r0.date, epoch: r0.epoch || 0, rotationCut: a.mode === 'logRotation' || !!r0.rotationCut, record: structuredClone(r0), clearedAt: iso(), clearedBy: ctx.name });
      if (a.mode === 'logRotation') for (const x of ledger) x.rotationCut = true; // الدور أُعيد من البداية: لا يُطبَّق فرق دور أي يوم ممسوح سابقًا
      dep.clearedLedger = ledger.sort((x, y) => (x.date < y.date ? -1 : 1));
      delete dep.logClearedUpTo;
      d.days = d.days.filter(x => x.deptId !== dep.id);
      if (d.days.some(x => x.deptId === dep.id)) fail('تعذّر مسح سجل الأيام بالكامل؛ لم يُحفظ أي تغيير.');
      let cancelled = 0;
      if (a.mode === 'logRotation') {
        for (const x of dep.exclusions || []) if (x.status === 'active') { x.status = 'cancelled'; x.cancelledBy = ctx.name; x.cancelledAt = iso(); x.cancelReason = 'إعادة ضبط سجل الغياب والدور'; cancelled++; }
        dep.state = { ...dep.state, pointer: null, pending: [], skips: [], earlyTurns: [], pendingSeq: 0, manualNext: null }; // الديون كما هي
      }
      bump(dep, bk.id);
      const ts = teachersOf(d, dep.id);
      const nx = Engine.nextPriority(Engine.buildRing(ts, dep.headTeacherId), new Map(ts.map(t => [t.id, t])), dep.state.pointer, dep.state.pending, dep.state.skips, dep.state.manualNext, dep.state.earlyTurns, dep.state.extraCredits);
      audit(d, ctx, 'إعادة ضبط سجل الغياب', `${dep.name} — ${label}: مُسح ${recs.length} يوم من السجل الفعّال${a.mode === 'logRotation' ? `، وأُعيد الدور من البداية وأُلغي ${cancelled} تجاوز مؤقت` : ''}. أرصدة الدين لم تتغير.`, dep.id, { before, after: stateSnap(dep), mode: a.mode, days: recs.length });
      return { ok: true, cleared: recs.length, cancelledExclusions: cancelled, next: nx.id, nextName: nx.id ? nameIn(d, nx.id) : null };
    }));

    // -- تقارير السجل (تُبنى من البيانات المحفوظة بالكود فقط) --
    const REPORT_EVENTS = {
      'تعديل دين يدوي': 'debt', 'تعديل رصيد إضافي': 'rotation', 'إعادة ضبط الدين والدور': 'reset', 'إعادة ضبط سجل الغياب': 'logReset', 'تراجع عن آخر تعديل': 'undo',
      'تحديد الدور يدويًا': 'rotation', 'إدارة الدور: تعديل الترتيب': 'rotation', 'تعديل ترتيب الدور': 'rotation', 'إدارة الدور: بدء الدور من معلم محدد': 'rotation',
      'تخطي نهائي لهذه المرة — دون حفظ حق الدور': 'rotation', 'إلغاء تخطٍّ مسجل': 'rotation',
      'تجاوز مؤقت — يحتفظ بحق الدور': 'exclusion', 'إلغاء تجاوز مؤقت': 'exclusion',
      'تصحيح غياب يوم معتمد': 'correction', 'اعتماد الحالة الافتتاحية': 'opening', 'إعادة تسجيل يوم مُسح سجله': 'rerecord',
      'تعديل طريقة إدارة الاحتياط': 'settings', 'إعادة ضبط الدين فقط': 'reset', 'إعادة ضبط الدور فقط': 'reset'
    };
    // لا تُطبع الأسباب ولا الملاحظات الشخصية: يُحذف ما بعد «السبب» وملاحظة التجاوز
    function cleanEventText(action, details) {
      let t = String(details || '');
      if (REPORT_EVENTS[action] === 'exclusion') t = t.split(' — ').slice(0, 3).join(' — ').replace(/ — (تكليف|ظروف اليوم|سبب آخر)(:.*)?$/, '');
      t = t.replace(/ — السبب: .*$/, '').replace(/ — ملاحظة: .*$/, '');
      return t.slice(0, 300);
    }
    // تقرير قسم واحد (يُستخدم لتقرير القسم ولتقرير المدرسة لكل قسم على حدة)
    function deptReport(dep, a) {
      const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
      const from = a.from ? String(a.from) : null, to = a.to ? String(a.to) : null;
      if ((from && !isDate(from)) || (to && !isDate(to))) fail('صيغة التاريخ غير صحيحة.');
      if (from && to && to < from) fail('تاريخ النهاية يسبق تاريخ البداية.');
      const type = a.type === 'summary' ? 'summary' : 'detail';
      const all = teachersOf(db, dep.id);
      const tById = new Map(all.map(t => [t.id, t]));
      let teacher = null;
      if (a.teacherId) { teacher = tById.get(a.teacherId); if (!teacher) fail('اختر معلمًا من معلمي هذا القسم.'); }
      const inRange = dt => (!from || dt >= from) && (!to || dt <= to);
      const today = kuwaitToday(now());
      const nm = id => (tById.get(id) || {}).name || '—';
      const byName = new Map(all.map(t => [t.name, t.id]));
      const tid = teacher ? teacher.id : null;
      const keyOf = s0 => s0.absentId + '|' + s0.period + '|' + s0.cls;

      // الأيام المعتمدة الفعّالة فقط (أحدث نسخة)؛ لا سجلات ممسوحة ولا نسخ احتياطية
      const days = db.days.filter(x => x.deptId === dep.id && inRange(x.date)).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
      const rows = []; const dayInfo = []; const corrections = [];
      for (const rec of days) {
        const r = rec.result;
        const hasExec = !!rec.marks;
        for (const s0 of r.slots) {
          if (tid && s0.absentId !== tid && s0.teacherId !== tid) continue;
          rows.push({ id: rec.id + '#' + keyOf(s0) + '#' + (s0.teacherId || '-'), date: rec.date, dayKey: rec.dayKey, period: s0.period, cls: s0.cls, absentId: s0.absentId, absentName: s0.absentName,
            teacherId: s0.teacherId || null, teacherName: s0.teacherName || null, source: s0.source || null,
            status: s0.status === 'covered' ? 'covered' : s0.status === 'admin' ? 'admin' : 'uncovered', exec: s0.status !== 'covered' ? null : (s0.executed ? 'done' : 'unrecorded'),
            orphan: !!s0.orphan, manual: !!s0.manual });
        }
        const debtMoves = (r.debtRows || []).filter(x => (x.add || x.paid) && (!tid || x.id === tid)).map(x => ({ teacherId: x.id, name: x.name, add: x.add, paid: x.paid }));
        const abs = (r.absentees || []).filter(x => !tid || x.id === tid).map(x => ({ id: x.id, name: x.name, periods: x.periods, partial: x.partial || null }));
        dayInfo.push({ id: rec.id, date: rec.date, dayKey: rec.dayKey, noAbsence: !!rec.noAbsence, absentees: abs, debtMoves, hasExec,
          corrected: !!(rec.versions && rec.versions.length > 1), rerecord: !!rec.rerecord, approvedBy: rec.approvedBy, approvedAt: rec.approvedAt, cap: r.cap && r.cap.on ? r.cap : null });
        // تاريخ التصحيحات قسم منفصل: التكليفات الملغاة لا تُحتسب ضمن الفعّالة
        const vs = rec.versions || [];
        for (let i = 1; i < vs.length; i++) {
          const prev = vs[i - 1].result, v = vs[i];
          const cancelled = (prev.slots || []).filter(x => x.status === 'covered' && ['cancel', 'replace'].includes((v.marks || {})[keyOf(x)]) && (!tid || x.teacherId === tid || x.absentId === tid))
            .map(x => ({ period: x.period, cls: x.cls, absentName: x.absentName, teacherName: x.teacherName, source: x.source }));
          const absTxt = res => (res.absentees || []).map(x => x.partial ? `${x.name} (الحصص ${x.partial.join('، ')})` : x.name).join('، ') || 'لا يوجد غياب';
          corrections.push({ date: rec.date, no: v.no, at: v.at, by: v.by, absBefore: absTxt(prev), absAfter: absTxt(v.result), cancelled,
            debtChanges: ((v.summary || {}).debtChanges || []).filter(x => !tid || x.name === teacher.name) });
        }
      }

      // الحصة المحالة: لمن أسندتها الإدارة (رابط واحد، دون عدّها مرتين)، والتكليفات الواردة من الإدارة لمعلمي القسم
      for (const x of rows) if (x.status === 'admin') { const act = aaActive(db, refOf(dep.id, x.date, x.absentId + '|' + x.period + '|' + x.cls)); if (act && act.state === 'assigned') x.adminTo = { teacherName: act.teacherName, deptName: act.toDeptName, source: act.source }; else if (act) x.adminTo = { uncoverable: true }; }
      for (const e of aaList(db)) if (e.state === 'assigned' && e.toDeptId === dep.id && inRange(e.date) && (!tid || e.teacherId === tid))
        rows.push({ id: 'aa#' + e.id, date: e.date, dayKey: Engine.dayKeyOf(e.date), period: e.period, cls: e.cls, absentId: null, absentName: `${e.absentName} — ${e.srcDeptName}`,
          teacherId: e.teacherId, teacherName: e.teacherName, source: e.source, status: 'covered', exec: e.exec === 'done' ? 'done' : 'unrecorded', orphan: false, manual: false, fromAdmin: true });
      // دفتر الدين + السجل الإداري القديم
      const J = (dep.debtJournal || []).slice();
      const undoneRefs = new Set(J.filter(x => x.kind === 'undo').map(x => x.ref));
      const legacyMax = dep.legacyMaxDate || null;
      const auditDept = db.audit.filter(x => x.deptId === dep.id);
      const journalStartAt = J.length ? J[0].at : null;
      // تعديلات يدوية: من الدفتر، ومن السجل الإداري للأقدم منه (مع استبعاد ما تُرُاجع عنه)
      const manual = [];
      for (const x of J) if (x.kind === 'manual' && !undoneRefs.has(x.ref)) manual.push({ date: x.date, at: x.at, teacherId: x.teacherId, delta: x.delta, before: x.before, after: x.after, actor: x.actor });
      const undoTexts = auditDept.filter(x => x.action === 'تراجع عن آخر تعديل').map(x => ({ at: x.at, text: x.details, used: false }));
      for (const x of auditDept) {
        if (x.action !== 'تعديل دين يدوي' || x.backupId) continue; // ما فيه backupId مسجل في الدفتر
        const m = /^(.*): (\d+) ← (\d+)$/.exec(x.details || ''); if (!m) continue;
        const id = byName.get(m[1]); if (!id) continue;
        const b0 = +m[2], a0 = +m[3];
        const desc = `${a0 > b0 ? 'زيادة' : 'إنقاص'} دين «${m[1]}» من ${b0} إلى ${a0}`;
        const u = undoTexts.find(y => !y.used && y.at > x.at && y.text === desc);
        if (u) { u.used = true; continue; }
        manual.push({ date: kuwaitToday(new Date(x.at)), at: x.at, teacherId: id, delta: a0 - b0, before: b0, after: a0, actor: x.actor, legacy: true });
      }
      // إعادة ضبط الدين والدور: نقطة تغيير موثقة
      const resets = [];
      for (const x of J) if (x.kind === 'reset' && !undoneRefs.has(x.ref)) resets.push({ date: x.date, at: x.at, teacherId: x.teacherId, delta: x.delta, before: x.before });
      for (const x of auditDept) {
        if (x.action !== 'إعادة ضبط الدين والدور' || (journalStartAt && x.at >= journalStartAt) || !x.before) continue;
        if (undoTexts.some(y => y.at > x.at && /^إعادة ضبط الدين والدور/.test(y.text))) continue;
        for (const [n0, v] of Object.entries(x.before.debts || {})) { const id = byName.get(n0); if (id && v > 0) resets.push({ date: kuwaitToday(new Date(x.at)), at: x.at, teacherId: id, delta: -v, before: v, legacy: true }); }
      }
      const resetEvents = auditDept.filter(x => x.action === 'إعادة ضبط الدين والدور' && inRange(kuwaitToday(new Date(x.at)))).map(x => ({ date: kuwaitToday(new Date(x.at)), at: x.at, actor: x.actor }));

      // الأرصدة: من الرصيد الحالي رجوعًا بحركات الدفتر؛ تُعرض فقط إذا كانت كل الحركات بعد النقطة مسجلة في الدفتر
      const cur = dep.state.debts || {};
      const startKnown = !legacyMax || (from && from > legacyMax);
      const endKnown = !legacyMax || (to && to >= legacyMax) || (!to);
      const balanceAt = (id, pred) => Math.max(0, cur[id] || 0) - J.filter(x => x.teacherId === id && pred(x.date)).reduce((sum, x) => sum + x.delta, 0);
      const startBal = id => (!startKnown ? null : from ? balanceAt(id, dt => dt >= from) : null);
      const endBal = id => (!endKnown ? null : to ? balanceAt(id, dt => dt > to) : Math.max(0, cur[id] || 0));

      // ملخص لكل معلم (من معرّفات التكليفات والحركات، دون تكرار)
      const execKnownDays = days.filter(x => x.marks).length;
      const summaryOf = t => {
        const mine = rows.filter(x => x.teacherId === t.id && x.status === 'covered');
        const ids = new Set(); const uniq = mine.filter(x => (ids.has(x.id) ? false : ids.add(x.id)));
        let absDays = 0, absPeriods = 0, added = 0, paid = 0;
        for (const rec of days) {
          const ab = (rec.result.absentees || []).find(x => x.id === t.id);
          if (ab) { absDays++; absPeriods += ab.periods; }
          const dr = (rec.result.debtRows || []).find(x => x.id === t.id);
          if (dr) { added += dr.add || 0; paid += dr.paid || 0; }
        }
        paid += uniq.filter(x => x.fromAdmin && x.source === 'debt').length; // تسديد بتكليف من الإدارة
        const man = manual.filter(x => x.teacherId === t.id && inRange(x.date));
        const rs = resets.filter(x => x.teacherId === t.id && inRange(x.date));
        return {
          teacherId: t.id, name: t.name, status: t.status, isHead: t.id === dep.headTeacherId,
          assigned: uniq.length, byDebt: uniq.filter(x => x.source === 'debt').length, byRotation: uniq.filter(x => x.source === 'rotation').length,
          executed: execKnownDays ? uniq.filter(x => x.exec === 'done').length : null,
          absDays, absPeriods, added, paid,
          manualPlus: man.filter(x => x.delta > 0).reduce((s1, x) => s1 + x.delta, 0), manualMinus: man.filter(x => x.delta < 0).reduce((s1, x) => s1 - x.delta, 0),
          manualNet: man.reduce((s1, x) => s1 + x.delta, 0), resetEffect: rs.reduce((s1, x) => s1 + x.delta, 0), resetCount: rs.length,
          startBalance: startBal(t.id), endBalance: endBal(t.id)
        };
      };
      // ملخص الجميع: كل معلمي القسم الفعّالين، ومن له حركة من المؤرشفين
      const list = teacher ? [teacher] : all.filter(t => t.status === 'active' || rows.some(x => x.teacherId === t.id || x.absentId === t.id) || manual.some(x => x.teacherId === t.id && inRange(x.date)));
      const summary = list.map(summaryOf);
      const totals = {};
      for (const k of ['assigned', 'byDebt', 'byRotation', 'absDays', 'absPeriods', 'added', 'paid', 'manualPlus', 'manualMinus', 'manualNet', 'resetEffect']) totals[k] = summary.reduce((s1, x) => s1 + x[k], 0);
      totals.executed = execKnownDays ? summary.reduce((s1, x) => s1 + x.executed, 0) : null;
      totals.endBalance = summary.every(x => x.endBalance != null) ? summary.reduce((s1, x) => s1 + x.endBalance, 0) : null;
      totals.startBalance = summary.every(x => x.startBalance != null) ? summary.reduce((s1, x) => s1 + x.startBalance, 0) : null;
      // للتحقق: عدد التكليفات الفعّالة الفريدة في الفترة يساوي مجموع الجدول (للجميع)
      const uniqueAssignments = new Set(rows.filter(x => x.status === 'covered').map(x => x.id)).size;

      // الأحداث المؤثرة في الدين والدور (السجل الإداري، دون أسباب أو ملاحظات)
      const events = [];
      for (const x of auditDept) {
        const cat = REPORT_EVENTS[x.action]; if (!cat) continue;
        const dt = kuwaitToday(new Date(x.at)); if (!inRange(dt)) continue;
        const text = cleanEventText(x.action, x.details);
        if (tid) {
          const mentions = x.teacherId ? x.teacherId === tid : new RegExp('(^|[«\\s:،(])' + teacher.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[»\\s:،)—])').test(text);
          if (!mentions && !['reset', 'logReset'].includes(cat)) continue;
        }
        events.push({ date: dt, at: x.at, category: cat, action: x.action, text, actor: x.actor, role: x.role });
      }
      events.sort((x, y) => (x.at < y.at ? -1 : 1));
      const journalRows = J.filter(x => inRange(x.date) && (!tid || x.teacherId === tid) && x.kind !== 'day' && x.kind !== 'rerecord' && x.kind !== 'admin' && x.kind !== 'adminCancel')
        .map(x => ({ date: x.date, at: x.at, kind: x.kind, name: nm(x.teacherId), before: x.before, after: x.after, delta: x.delta, undone: x.kind === 'manual' && undoneRefs.has(x.ref), actor: x.actor }));

      // تنبيهات اكتمال البيانات
      const notes = [];
      const clearedIn = new Set();
      for (const e of dep.clearedLedger || []) if (inRange(e.date)) clearedIn.add(e.date);
      for (const b of dep.backups || []) if (b.action === 'إعادة ضبط سجل الغياب' && !b.undone) for (const r0 of (b.snapshot && b.snapshot.clearedDays) || []) if (inRange(r0.date) && !days.some(x => x.date === r0.date)) clearedIn.add(r0.date);
      if (clearedIn.size) notes.push({ kind: 'warn', text: `تتضمن الفترة أيامًا مُسح سجلها بإعادة ضبط سجل الغياب (${Array.from(clearedIn).sort().join('، ')}). لا تظهر في هذا التقرير، وآثارها السابقة على الدين محسوبة في الأرصدة فقط.` });
      const sch = dep.scheduleApproved;
      if (sch && from) {
        const missing = [];
        const end = to && to < today ? to : today;
        for (let dt = new Date(from + 'T12:00:00Z'); dt.toISOString().slice(0, 10) <= end && missing.length < 60; dt.setUTCDate(dt.getUTCDate() + 1)) {
          const ds = dt.toISOString().slice(0, 10);
          if (sch.days.includes(Engine.dayKeyOf(ds)) && !days.some(x => x.date === ds) && !clearedIn.has(ds)) missing.push(ds);
        }
        if (missing.length) notes.push({ kind: 'info', text: `أيام دراسية في الفترة بلا توزيع معتمد في السجل (${missing.join('، ')}). قد يكون السجل غير مكتمل لهذه الأيام.` });
      }
      if (!startKnown || !endKnown) notes.push({ kind: 'info', text: `أرصدة بداية الفترة أو نهايتها غير متاحة من السجل المحفوظ: دفتر حركات الدين بدأ بعد حركات سابقة (آخرها بتاريخ ${legacyMax}). تتوفر الأرصدة لفترات تبدأ بعد هذا التاريخ.` });
      if (!from) notes.push({ kind: 'info', text: 'لم يُحدَّد «من تاريخ»، فرصيد بداية الفترة غير محدد.' });
      const nAdmin = rows.filter(x => x.status === 'admin').length, nUnc = rows.filter(x => x.status === 'uncovered').length;
      if (nAdmin) notes.push({ kind: 'info', text: `حصص محالة إلى الإدارة في الفترة: ${nAdmin} — لا تُحتسب احتياطًا نفّذه أحد معلمي القسم، وتختلف عن الحصص غير المغطاة (${nUnc}).` });
      if (rows.some(x => x.status === 'covered') && execKnownDays < days.length) notes.push({ kind: 'info', text: execKnownDays ? `حالة التنفيذ الفعلي مسجلة لأيام صُحّح غيابها فقط (${execKnownDays} من ${days.length})؛ في غيرها «التنفيذ غير مسجل».` : 'حالة التنفيذ الفعلي غير مسجلة لأي يوم في الفترة؛ التكليف المعتمد ليس دليلًا على التنفيذ.' });
      if (manual.some(x => x.legacy && inRange(x.date))) notes.push({ kind: 'info', text: 'بعض التعديلات اليدوية أقدم من دفتر حركات الدين، واستُخرجت من سجل التغييرات.' });

      return {
        meta: { systemName: db.meta.systemName, deptId: dep.id, deptName: dep.name, school: dep.school || '', teacherId: tid, teacherName: teacher ? teacher.name : null,
          type, from, to, generatedAt: iso(), headId: dep.headTeacherId },
        days: dayInfo, rows, corrections, events, journal: journalRows, resetEvents,
        manual: manual.filter(x => inRange(x.date) && (!tid || x.teacherId === tid)).map(x => ({ ...x, name: nm(x.teacherId) })),
        summary, totals, uniqueAssignments, notes, balances: { startKnown, endKnown, legacyMax },
        empty: !days.length && !events.length && !journalRows.length && !summary.some(x => x.manualNet || x.resetEffect)
      };
    }
    op('report.build', ['admin', 'head'], async (ctx, a) => deptReport(deptIn(db, scope(ctx, a.deptId)), a));

    // -- الحسابات --
    const accView = a => {
      const dep = deptIn(db, a.deptId);
      const tch = a.teacherId ? db.teachers.find(t => t.id === a.teacherId) : null;
      const sc = a.schoolId ? schoolIn(db, a.schoolId) : null;
      return { id: a.id, name: a.name, kind: kindOf(a), kindName: KIND_NAMES[kindOf(a)], schoolId: a.schoolId || null, schoolName: sc ? sc.name : null, teacherId: a.teacherId || null, teacherName: tch ? tch.name : null, revoked: !!a.revoked, civilMasked: maskCivil(a.civilId), deptId: a.deptId || null, deptName: dep ? dep.name : (sc ? '' : '—'), status: a.status, pendingPurpose: a.code ? a.code.purpose : null, codeExpiresAt: a.code ? a.code.expiresAt : null, createdAt: a.createdAt, activatedAt: a.activatedAt || null };
    };
    async function issueCode(acc, purpose) {
      const code = makeCode();
      acc.code = { hash: await sha256(normCode(code)), purpose, expiresAt: new Date(now().getTime() + CODE_HOURS * 3600e3).toISOString() };
      return code;
    }
    // حسابات مدرسة واحدة: إدارتها وحسابات رؤساء أقسامها ونوابهم. مدير المدرسة ومساعدوه يطّلعون فقط (الإنشاء والتعديل لمدير النظام)
    const accInSchool = (d, a, sid) => a.schoolId === sid || (a.deptId && (deptIn(d, a.deptId) || {}).schoolId === sid);
    op('account.list', ['admin', 'school'], async (ctx, a) => {
      const sid = ctx.role === 'school' ? ctx.schoolId : (a && a.schoolId) || null;
      if (sid && !schoolIn(db, sid)) fail('المدرسة غير موجودة.', 'not_found');
      // حسابات المعلمين في صفحتها المستقلة (عددها كبير)، وتُطلب بـ kind: 'teacher'
      const wantT = a && a.kind === 'teacher';
      return (sid ? db.accounts.filter(x => x.kind !== 'organizer' && x.role !== 'admin' && accInSchool(db, x, sid)) : db.accounts).filter(x => (x.kind === 'teacher') === wantT).map(accView);
    });

    // -- نواب رئيس القسم (مدير النظام فقط) --
    op('deputy.list', ['admin'], async () => {
      const out = [];
      for (const dep of db.departments) for (const tid of dep.deputyTeacherIds || []) {
        const t = db.teachers.find(x => x.id === tid);
        const acc = db.accounts.find(x => x.kind === 'deputy' && x.teacherId === tid && !x.revoked);
        out.push({ deptId: dep.id, deptName: dep.name, teacherId: tid, teacherName: t ? t.name : '—', account: acc ? accView(acc) : null });
      }
      const unlinked = db.accounts.filter(x => x.kind === 'deputy' && !x.teacherId).map(accView);
      return { deputies: out, unlinked };
    });
    op('deputy.add', ['admin'], async (ctx, a) => {
      const dep0 = deptIn(db, scope(ctx, a.deptId));
      const t0 = db.teachers.find(x => x.id === a.teacherId && x.deptId === dep0.id);
      if (!t0) fail('اختر معلمًا من معلمي هذا القسم.');
      if (t0.status !== 'active') fail('المعلم غير فعّال.');
      if (t0.id === dep0.headTeacherId) fail('رئيس القسم لا يُعيَّن نائبًا لنفسه.');
      const hasAcc = id => db.accounts.some(x => x.kind === 'deputy' && x.teacherId === id && !x.revoked);
      // نائب بلا حساب (مثل القسم التجريبي): يُسمح بإنشاء/ربط حسابه فقط دون تكرار تعيينه
      const already = (dep0.deputyTeacherIds || []).includes(t0.id);
      if (already && hasAcc(t0.id)) fail('هذا المعلم نائب لرئيس القسم مسبقًا في هذا القسم.', 'conflict');
      const mode = a.account && a.account.mode;
      let newAcc = null, code = null, linkId = null;
      if (mode === 'new') {
        const civilId = cleanCivil(a.account.civilId); const name = cleanName(a.account.name || t0.name);
        if ((db.admin && db.admin.civilId === civilId) || db.accounts.some(x => x.civilId === civilId)) fail('يوجد حساب بهذا الرقم المدني. اختر «ربط حساب موجود» إن كان حساب هذا المعلم.');
        newAcc = { id: uid('acc'), name, civilId, deptId: dep0.id, kind: 'deputy', teacherId: t0.id, status: 'pending', pw: null, code: null, createdAt: iso() };
        code = await issueCode(newAcc, 'activate');
      } else if (mode === 'link') {
        const acc = db.accounts.find(x => x.id === a.account.accountId);
        if (!acc || acc.deptId !== dep0.id) fail('الحساب المختار ليس من هذا القسم.');
        if (acc.kind === 'head' && !acc.teacherId) fail('هذا حساب رئيس قسم؛ لا يُحوَّل إلى نائب.');
        if (acc.teacherId && acc.teacherId !== t0.id) fail('الحساب مربوط بمعلم آخر.');
        linkId = acc.id;
      } else fail('اختر إنشاء حساب جديد أو ربط حساب موجود.');
      return tx(d => {
        const dep = deptIn(d, dep0.id);
        const isDep = (dep.deputyTeacherIds || []).includes(t0.id);
        if (isDep && d.accounts.some(x => x.kind === 'deputy' && x.teacherId === t0.id && !x.revoked)) fail('هذا المعلم نائب لرئيس القسم مسبقًا في هذا القسم.', 'conflict');
        if (!isDep) dep.deputyTeacherIds = (dep.deputyTeacherIds || []).concat([t0.id]);
        if (newAcc) d.accounts.push(newAcc);
        if (linkId) { const acc = d.accounts.find(x => x.id === linkId); acc.kind = 'deputy'; acc.teacherId = t0.id; acc.revoked = false; if (acc.status === 'disabled') acc.status = acc.pw ? 'active' : 'pending'; }
        audit(d, ctx, 'تعيين نائب رئيس قسم', `${t0.name}${newAcc ? ' — حساب جديد بانتظار التفعيل' : ' — ربط حساب موجود'}`, dep.id);
        return { ok: true, code, expiresAt: newAcc ? newAcc.code.expiresAt : null, accountName: newAcc ? newAcc.name : null };
      });
    });
    op('deputy.remove', ['admin'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId));
      if (!(dep.deputyTeacherIds || []).includes(a.teacherId)) fail('هذا المعلم ليس نائبًا في هذا القسم.');
      dep.deputyTeacherIds = dep.deputyTeacherIds.filter(x => x !== a.teacherId);
      // يعود معلمًا عاديًا: لا يُمس سجله ولا دينه ولا ترتيب دوره ولا تكليفاته
      for (const acc of d.accounts.filter(x => x.kind === 'deputy' && x.teacherId === a.teacherId)) {
        acc.status = 'disabled'; acc.revoked = true; acc.code = null;
        d.sessions = d.sessions.filter(s0 => s0.accountId !== acc.id);
      }
      audit(d, ctx, 'إزالة صلاحية نائب رئيس القسم', nameIn(d, a.teacherId), dep.id);
      return { ok: true };
    }));
    op('account.create', ['admin'], async (ctx, a) => {
      if (a.kind === 'deputy') fail('حسابات النواب تُنشأ من صفحة «نواب رئيس القسم» مع اختيار سجل المعلم.');
      const civilId = cleanCivil(a.civilId); const name = cleanName(a.name);
      // حساب مدير مدرسة أو مساعد مدير: مرتبط بمدرسة لا بقسم، ولا يُضاف إلى معلمي أي قسم أو ترتيب دوره
      if (SCHOOL_KINDS.includes(a.kind)) {
        const sc = schoolIn(db, a.schoolId); if (!sc) fail('اختر المدرسة.');
        if ((db.admin && db.admin.civilId === civilId) || db.accounts.some(x => x.civilId === civilId)) fail('يوجد حساب بهذا الرقم المدني.');
        const acc = { id: uid('acc'), name, civilId, deptId: null, schoolId: sc.id, kind: a.kind, status: 'pending', pw: null, code: null, createdAt: iso() };
        const code = await issueCode(acc, 'activate');
        await tx(d => { d.accounts.push(acc); audit(d, ctx, `إنشاء حساب ${KIND_NAMES[a.kind]}`, `${name} — ${sc.name}`, null, { schoolId: sc.id }); });
        return { account: accView(acc), code, expiresAt: acc.code.expiresAt };
      }
      if (!deptIn(db, a.deptId)) fail('اختر القسم.');
      if ((db.admin && db.admin.civilId === civilId) || db.accounts.some(x => x.civilId === civilId)) fail('يوجد حساب بهذا الرقم المدني.');
      const kind = 'head';
      const acc = { id: uid('acc'), name, civilId, deptId: a.deptId, kind, status: 'pending', pw: null, code: null, createdAt: iso() };
      const code = await issueCode(acc, 'activate');
      await tx(d => { d.accounts.push(acc); audit(d, ctx, kind === 'deputy' ? 'إنشاء حساب نائب رئيس قسم' : 'إنشاء حساب رئيس قسم', name, a.deptId); });
      return { account: accView(acc), code, expiresAt: acc.code.expiresAt };
    });
    op('account.issueCode', ['admin'], async (ctx, a) => {
      const acc0 = db.accounts.find(x => x.id === a.accountId); if (!acc0) fail('الحساب غير موجود.', 'not_found');
      if (acc0.status === 'disabled') fail('الحساب معطّل. فعّله أولًا.');
      const purpose = a.purpose === 'reset' ? 'reset' : (acc0.pw ? 'reset' : 'activate');
      let code, exp;
      await tx(async d => {
        const acc = d.accounts.find(x => x.id === a.accountId);
        code = await issueCode(acc, purpose); exp = acc.code.expiresAt;
        if (purpose === 'reset') { acc.pw = null; acc.status = 'pending'; d.sessions = d.sessions.filter(s => s.accountId !== acc.id); }
        audit(d, ctx, purpose === 'reset' ? 'بدء إعادة تعيين كلمة المرور' : 'إصدار رمز تفعيل جديد', acc.name, acc.deptId);
      });
      return { code, expiresAt: exp, purpose };
    });
    op('account.setStatus', ['admin'], async (ctx, a) => tx(d => {
      const acc = d.accounts.find(x => x.id === a.accountId); if (!acc) fail('الحساب غير موجود.', 'not_found');
      if (a.status === 'disabled') { acc.status = 'disabled'; acc.code = null; d.sessions = d.sessions.filter(s => s.accountId !== acc.id); audit(d, ctx, 'تعطيل حساب', acc.name, acc.deptId); if (SCHOOL_KINDS.includes(acc.kind)) suspendGrantsBy(d, acc.id, `تعطيل حساب المانح (${acc.name})`, ctx); }
      else {
        if (acc.revoked) fail('أُزيلت صلاحية هذا النائب. أعد تعيينه من صفحة «نواب رئيس القسم» بدل إلغاء التعطيل.');
        acc.status = acc.pw ? 'active' : 'pending'; audit(d, ctx, 'إلغاء تعطيل حساب', acc.name, acc.deptId);
      }
      return { ok: true };
    }));
    op('account.update', ['admin'], async (ctx, a) => tx(d => {
      const acc = d.accounts.find(x => x.id === a.accountId); if (!acc) fail('الحساب غير موجود.', 'not_found');
      if (SCHOOL_KINDS.includes(acc.kind)) {
        if (a.deptId) fail('حساب المدرسة لا يرتبط بقسم.');
        if (a.schoolId && a.schoolId !== acc.schoolId) { if (!schoolIn(d, a.schoolId)) fail('المدرسة غير موجودة.'); suspendGrantsBy(d, acc.id, `نقل حساب المانح (${acc.name}) إلى مدرسة أخرى`, ctx); acc.schoolId = a.schoolId; d.sessions = d.sessions.filter(s => s.accountId !== acc.id); }
        if (a.kind && SCHOOL_KINDS.includes(a.kind) && a.kind !== acc.kind) { audit(d, ctx, 'تعديل صلاحية حساب المدرسة', `${acc.name}: ${KIND_NAMES[acc.kind]} ← ${KIND_NAMES[a.kind]}`, null, { schoolId: acc.schoolId }); acc.kind = a.kind; }
      } else if (a.deptId && a.deptId !== acc.deptId) { if (!deptIn(d, a.deptId)) fail('القسم غير موجود.'); acc.deptId = a.deptId; d.sessions = d.sessions.filter(s => s.accountId !== acc.id); }
      if (a.name) acc.name = cleanName(a.name);
      audit(d, ctx, 'تعديل حساب', acc.name, acc.deptId); return { ok: true };
    }));

    // ================= مستوى المدرسة =================
    const SCHOOL_STATUS = { active: 'فعّالة', inactive: 'غير فعّالة' };
    const schoolView = (d, sc) => ({
      id: sc.id, name: sc.name, status: sc.status, createdAt: sc.createdAt,
      deptCount: deptsOfSchool(d, sc.id).length,
      accounts: d.accounts.filter(x => x.schoolId === sc.id && SCHOOL_KINDS.includes(x.kind)).map(x => ({ id: x.id, name: x.name, kind: x.kind, kindName: KIND_NAMES[x.kind], status: x.status })),
      lateHours: !!(sc.lateHours && sc.lateHours.on), hasImportProfile: !!sc.importProfile
    });
    op('school.list', ['admin', 'school'], async ctx => {
      const list = ctx.role === 'admin' ? (db.schools || []) : (db.schools || []).filter(x => x.id === ctx.schoolId);
      return { schools: list.map(x => schoolView(db, x)), unlinkedDepts: ctx.role === 'admin' ? db.departments.filter(x => !x.schoolId).map(x => ({ id: x.id, name: x.name, school: x.school || '', demo: !!x.demo })) : [] };
    });
    op('school.create', ['admin'], async (ctx, a) => tx(d => {
      const name = cleanName(a.name, 'اسم المدرسة');
      if ((d.schools || []).some(x => x.name === name)) fail('توجد مدرسة بالاسم نفسه.');
      const sc = { id: uid('sch'), name, status: 'active', createdAt: iso(), importProfile: null };
      d.schools = (d.schools || []).concat([sc]);
      audit(d, ctx, 'إنشاء مدرسة', name, null, { schoolId: sc.id });
      return { id: sc.id };
    }));
    op('school.update', ['admin'], async (ctx, a) => tx(d => {
      const sc = schoolIn(d, a.schoolId); if (!sc) fail('المدرسة غير موجودة.', 'not_found');
      const ch = [];
      if (a.name != null) {
        const n = cleanName(a.name, 'اسم المدرسة');
        if (n !== sc.name) {
          if (d.schools.some(x => x.id !== sc.id && x.name === n)) fail('توجد مدرسة بالاسم نفسه.');
          ch.push(`الاسم: ${sc.name} ← ${n}`); sc.name = n;
          for (const dep of deptsOfSchool(d, sc.id)) dep.school = n;
        }
      }
      if (a.status != null) {
        const st = a.status === 'inactive' ? 'inactive' : 'active';
        if (st !== sc.status) { ch.push(`الحالة: ${SCHOOL_STATUS[st]}`); sc.status = st; if (st === 'inactive') { const ids = new Set(d.accounts.filter(x => x.schoolId === sc.id).map(x => x.id)); d.sessions = d.sessions.filter(x => !ids.has(x.accountId)); } }
      }
      if (ch.length) audit(d, ctx, 'تعديل بيانات المدرسة', ch.join('، '), null, { schoolId: sc.id });
      return { ok: true };
    }));
    // ربط قسم قائم بمدرسة: باختيار مدير النظام فقط، ولا يغيّر معلميه أو ديونه أو دوره أو حساباته أو سجلاته
    op('dept.setSchool', ['admin'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId));
      const sid = a.schoolId || null;
      const sc = sid ? schoolIn(d, sid) : null; if (sid && !sc) fail('المدرسة غير موجودة.', 'not_found');
      if ((dep.schoolId || null) === sid) return { ok: true, changed: false };
      if (sc && d.departments.some(x => x.id !== dep.id && x.schoolId === sid && x.name === dep.name && !x.demo)) fail('يوجد في هذه المدرسة قسم بالاسم نفسه.');
      const before = dep.schoolId ? (schoolIn(d, dep.schoolId) || {}).name || '—' : 'غير مرتبط';
      if (sc) { dep.schoolId = sc.id; dep.school = sc.name; } else delete dep.schoolId;
      audit(d, ctx, 'ربط القسم بمدرسة', `${dep.name}: ${before} ← ${sc ? sc.name : 'غير مرتبط'}`, dep.id, { schoolId: sc ? sc.id : null });
      return { ok: true, changed: true };
    }));

    // حالة اليوم لقسم (مشتركة بين لوحة المدير ولوحة المدرسة)
    function deptToday(d, dep, today) {
      const pre = prerequisites(d, dep, today);
      const rec = d.days.find(x => x.deptId === dep.id && x.date === today);
      let status;
      if (dep.status !== 'active') status = { key: 'inactive', label: 'غير فعّال' };
      else if (rec) status = rec.noAbsence ? { key: 'approved_none', label: 'معتمد — لا يوجد غياب' } : { key: 'approved', label: `معتمد — ${rec.result.slots.length} احتياط` };
      else if (!dep.headTeacherId || !srcLatest(dep, today) || !dep.state.confirmed) status = { key: 'setup', label: 'بحاجة إلى إعداد' };
      else if (!pre.isStudy) status = { key: 'off', label: 'اليوم غير موجود في الجدول' };
      else status = { key: 'pending', label: 'لم يُعتمد اليوم' };
      const slots = rec ? rec.result.slots : [];
      return {
        ...deptView(d, dep, { role: 'admin' }), today: status,
        covered: slots.filter(x => x.status === 'covered').length, uncovered: slots.filter(x => x.status === 'uncovered').length,
        transferred: slots.filter(x => x.status === 'admin').length, absent: rec ? (rec.absentIds || []).length : 0,
        setupIssues: [!dep.headTeacherId && 'رئيس القسم', !srcLatest(dep, today) && 'الجدول المعتمد', !dep.state.confirmed && 'الحالة الافتتاحية'].filter(Boolean)
      };
    }
    const adminSlotsOf = (d, depIds, inRange) => {
      const names = Object.fromEntries(d.departments.map(x => [x.id, x.name]));
      const out = [];
      for (const rec of d.days) {
        if (!depIds.has(rec.deptId) || !inRange(rec.date)) continue;
        for (const s0 of (rec.result && rec.result.slots) || []) if (s0.status === 'admin')
          out.push({ date: rec.date, dayKey: rec.dayKey, deptId: rec.deptId, deptName: names[rec.deptId] || '—', period: s0.period, cls: s0.cls, absentId: s0.absentId, absentName: s0.absentName, key: s0.key });
      }
      return out.sort((x, y) => (x.date === y.date ? (x.deptName === y.deptName ? x.period - y.period : x.deptName < y.deptName ? -1 : 1) : x.date < y.date ? 1 : -1));
    };
    // حد ساعات الاستئذان الشهرية للمدرسة (12 ساعة على الأربعة): مطفأ افتراضيًا، لمدير النظام ومدير المدرسة فقط
    op('school.lateHoursSave', ['admin', 'school'], async (ctx, a) => tx(d => {
      if (ctx.role === 'school' && ctx.kind !== 'principal') fail('هذا الإعداد لمدير المدرسة أو مدير النظام فقط.', 'forbidden');
      const sc = schoolIn(d, schoolScope(ctx, a.schoolId)); if (!sc) fail('المدرسة غير موجودة.', 'not_found');
      const on = !!a.on; if (lateHoursOn(sc) === on) return { on };
      sc.lateHours = { on, at: iso(), by: ctx.role === 'admin' ? (d.admin && d.admin.name) || 'مدير النظام' : ctx.name };
      audit(d, ctx, 'حد ساعات الاستئذان', `${sc.name}: ${on ? 'تفعيل حد 12 ساعة شهريًا للاستئذان' : 'إيقاف حد الساعات'}`, null);
      return { on };
    }));
    op('school.dashboard', ['admin', 'school'], async (ctx, a) => {
      const sid = schoolScope(ctx, a.schoolId); const sc = schoolIn(db, sid);
      const today = kuwaitToday(now());
      const allow = new Set(deptsFor(ctx, sid, 'school.dashboard'));
      const depts = deptsOfSchool(db, sid).filter(x => allow.has(x.id)).map(dep => deptToday(db, dep, today));
      const ids = new Set(depts.map(x => x.id));
      return {
        today, school: { id: sc.id, name: sc.name, status: sc.status },
        counts: {
          departments: depts.length, needsSetup: depts.filter(x => x.today.key === 'setup').length,
          teachers: db.teachers.filter(t => ids.has(t.deptId) && t.status === 'active').length,
          approvedToday: depts.filter(x => x.today.key.startsWith('approved')).length,
          coveredToday: depts.reduce((s1, x) => s1 + x.covered, 0), uncoveredToday: depts.reduce((s1, x) => s1 + x.uncovered, 0),
          transferredToday: depts.reduce((s1, x) => s1 + x.transferred, 0)
        },
        departments: depts,
        transferredToday: adminSlotsOf(db, ids, dt => dt === today)
      };
    });
    const isDateStr = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
    function rangeOf(a) {
      const from = a.from ? String(a.from) : null, to = a.to ? String(a.to) : null;
      if ((from && !isDateStr(from)) || (to && !isDateStr(to))) fail('صيغة التاريخ غير صحيحة.');
      if (from && to && to < from) fail('تاريخ النهاية يسبق تاريخ البداية.');
      return { from, to, inRange: dt => (!from || dt >= from) && (!to || dt <= to) };
    }
    // الحصص المحالة إلى الإدارة في أقسام المدرسة (من الأيام المعتمدة بأحدث نسخها). ظهورها هنا لا يعني أنها غُطّيت.
    op('school.adminSlots', ['admin', 'school'], async (ctx, a) => {
      const sid = schoolScope(ctx, a.schoolId);
      const { from, to, inRange } = rangeOf(a);
      let ids = new Set(deptsFor(ctx, sid, 'school.adminSlots'));
      if (a.deptId) { const id = scope(ctx, a.deptId); if (!ids.has(id)) fail('القسم ليس من هذه المدرسة.', 'forbidden'); ids = new Set([id]); }
      return { from, to, items: adminSlotsOf(db, ids, inRange) };
    });
    // ==================== توزيع الحصص المحالة إلى الإدارة ====================
    /* الإحالة: حصة بحالة «محالة إلى الإدارة» في أحدث نسخة من يوم معتمد لقسم (مرجعها: القسم§التاريخ§مفتاح الحصة).
       قيود الإدارة (adminAssigns) لكل إحالة: إسناد (assigned) أو تعذّر (uncoverable)؛ الملغاة تبقى في السجل.
       الإسناد يُطبَّق على حالة القسم المستلم بقواعد محركه نفسه (الدين أو الدور) ويُسجَّل أثره ليُلغى بدقة. */
    const AA_NAMES = { pending: 'بانتظار التوزيع', assigned: 'تم الإسناد', cancelled: 'أُلغيت', uncoverable: 'تعذرت التغطية' };
    const AA_EXEC = { done: 'نُفّذت فعليًا', not: 'لم تُنفَّذ' };
    const refOf = (deptId, date, key) => [deptId, date, key].join('§');
    function parseRef(r) { const p = String(r || '').split('§'); if (p.length !== 3 || !/^\d{4}-\d{2}-\d{2}$/.test(p[1])) fail('مرجع الحصة غير صالح.'); return { srcDeptId: p[0], date: p[1], key: p[2] }; }
    const aaList = d => (Array.isArray(d.adminAssigns) ? d.adminAssigns : []);
    const aaActive = (d, ref) => aaList(d).find(x => x.ref === ref && (x.state === 'assigned' || x.state === 'uncoverable')) || null;
    const aaIncoming = (d, deptId, date, exceptId) => aaList(d).filter(x => x.state === 'assigned' && x.toDeptId === deptId && x.date === date && x.id !== exceptId);
    const aaBusy = (d, deptId, date, exceptId) => aaIncoming(d, deptId, date, exceptId).map(x => ({ teacherId: x.teacherId, period: x.period, label: `مكلّف من الإدارة في الحصة نفسها (${x.cls})` }));
    // معلم مكلّف من الإدارة لا يُسجَّل غائبًا في الحصة نفسها دون إلغاء التكليف أولًا
    function aaAbsentConflicts(d, dep, date, ids, periods) {
      const out = [];
      for (const x of aaIncoming(d, dep.id, date)) if (ids.includes(x.teacherId) && (!(periods || {})[x.teacherId] || periods[x.teacherId].includes(x.period)))
        out.push(`«${x.teacherName}» مكلّف من الإدارة بالحصة ${x.period} — الصف ${x.cls} (إحالة ${x.srcDeptName}). ألغِ التكليف من «الحصص المحالة إلى الإدارة» أولًا قبل تسجيله غائبًا فيها.`);
      return out;
    }
    function referralOf(d, ref) {
      const { srcDeptId, date, key } = parseRef(ref);
      if (srcDeptId === 'dir') fail('هذا تكليف مباشر من الإدارة؛ لتغييره ألغِه ثم أضف تكليفًا مباشرًا جديدًا.', 'conflict');
      const src = deptIn(d, srcDeptId); if (!src) fail('القسم المحيل غير موجود.', 'not_found');
      const rec = d.days.find(x => x.deptId === src.id && x.date === date) || null;
      const slot = rec ? (rec.result.slots || []).find(x => x.key === key && x.status === 'admin') || null : null;
      return { ref, src, rec, slot, date, key, schoolId: src.schoolId || null };
    }
    // المدرسة المسموحة لتوزيع الإحالات: المنظّم، إدارة المدرسة، أو مفوَّض بصلاحية «توزيع الحصص المحالة للإدارة» (نطاق المدرسة كلها)
    function distSchool(ctx, schoolId) {
      if (ctx.role === 'head') {
        const g = (ctx.grants || []).find(x => x.perms.has('adminDist') && (!schoolId || x.schoolId === schoolId));
        if (!g) fail('توزيع الحصص المحالة للإدارة ليس ضمن صلاحياتك المفوَّضة.', 'forbidden');
        ctx.usedGrant = g; return g.schoolId;
      }
      return schoolScope(ctx, schoolId);
    }
    const rotOf = sc => { const r = (sc && sc.adminRot) || {}; return { order: Array.isArray(r.order) ? r.order.slice() : [], last: r.last || null }; };
    const rotNext = (rot, ids) => { const order = rot.order.filter(id => ids.has(id)); if (!order.length) return null; const i = order.indexOf(rot.last); return order[(i + 1) % order.length]; };
    // سعة القسم المستلم: عند تفعيل التحويل وتحديد «حد القسم» = الحد − طلب القسم نفسه في يومه المعتمد − الوارد من الإدارة
    function distCapacity(d, dep, date) {
      const st = settingsOf(dep);
      if (!st.adminTransfer || st.cap == null) return { on: false };
      const rec = d.days.find(x => x.deptId === dep.id && x.date === date);
      const own = rec ? (rec.result.slots || []).filter(x => !x.orphan).length : null;
      const inc = aaIncoming(d, dep.id, date).length;
      return { on: true, limit: st.cap, own, incoming: inc, left: st.cap - (own || 0) - inc, ownUnknown: own == null };
    }
    const capText = c => `نفدت سعة القسم في هذا اليوم: حدّه ${c.limit}، وطلبه ${c.own == null ? 'غير معتمد بعد' : c.own}، والوارد من الإدارة ${c.incoming}.`;
    // تشغيل محرك القسم المستلم للحصص الواردة فقط، بحالته الحالية وغيابه وتكليفاته المعتمدة في التاريخ
    function distRun(d, dep, date, ext, manual, exceptId) {
      const issues = [];
      if (dep.status !== 'active') issues.push('القسم غير فعّال.');
      if (!dep.headTeacherId) issues.push('لم يُحدَّد رئيس القسم.');
      if (!dep.state.confirmed) issues.push('لم تُعتمد الحالة الافتتاحية للقسم.');
      const sch = SW.effAt(d, dep, date); const dayKey = Engine.dayKeyOf(date);
      if (!sch) issues.push('لا يوجد جدول ساري للقسم في هذا التاريخ.');
      else if (!sch.days.includes(dayKey)) issues.push(`جدول القسم لا يتضمن يوم ${Engine.DAY_NAMES[dayKey]}.`);
      if (issues.length) return { ok: false, issues };
      const rec = d.days.find(x => x.deptId === dep.id && x.date === date) || null;
      const busy = aaBusy(d, dep.id, date, exceptId);
      if (rec) for (const s0 of rec.result.slots || []) if (s0.status === 'covered' && s0.teacherId) busy.push({ teacherId: s0.teacherId, period: s0.period, label: `مكلّف باحتياط القسم في الحصة نفسها (${s0.cls})` });
      const st = settingsOf(dep);
      const r = Engine.computeDay({
        settings: { debt: st.debt, rotation: st.rotation, oneDaily: st.oneDaily }, transfers: [],
        teachers: teachersOf(d, dep.id).map(t => ({ id: t.id, name: t.name, status: t.status, inRotation: t.inRotation, rotationOrder: t.rotationOrder })),
        headId: dep.headTeacherId, dayKey, date, schedule: sch,
        absentIds: rec ? rec.absentIds.slice() : [], absentPeriods: rec ? structuredClone(rec.absentPeriods || {}) : {}, noAbsence: !(rec && rec.absentIds.length),
        state: dep.state, exclusions: activeExclusions(dep, date).map(x => ({ teacherId: x.teacherId, scope: x.scope, periods: x.periods })),
        manual: manual || {}, external: ext, externalOnly: true, busy
      });
      if (!r.ok) return { ok: false, issues: r.missing };
      return { ok: true, r, rec };
    }
    const nextNameOf = (d, dep) => { const ts = teachersOf(d, dep.id); const st = dep.state; const nx = Engine.nextPriority(Engine.buildRing(ts, dep.headTeacherId), new Map(ts.map(t => [t.id, t])), st.pointer, st.pending, st.skips, st.manualNext, st.earlyTurns, st.extraCredits); return nx.id ? nameIn(d, nx.id) : null; };
    // ترشيح قسم لحصة: المرشح الأول الفعلي ومصدره، أو سبب التعذر
    function distProbe(d, ra, dep, teacherId, reason) {
      const st = settingsOf(dep);
      const base = { deptId: dep.id, deptName: dep.name, debtOn: st.debt, rotOn: st.rotation, next: st.rotation ? nextNameOf(d, dep) : null };
      if (dep.id === ra.src.id) return { ...base, ok: false, reason: 'القسم المحيل نفسه؛ لا تُسند إليه الحصة مرة ثانية.' };
      if (!st.debt && !st.rotation) return { ...base, ok: false, reason: 'الدين والدور غير مفعّلين لهذا القسم؛ لا يوجد ترشيح تلقائي.' };
      const cap = distCapacity(d, dep, ra.date);
      if (cap.on && cap.left <= 0) return { ...base, ok: false, cap, reason: capText(cap) };
      const key = 'ext:' + ra.ref;
      const manual = teacherId ? { [key]: { teacherId, source: 'rotation', reason: String(reason || '').trim().slice(0, 300) } } : {};
      const x = distRun(d, dep, ra.date, [{ key, period: ra.slot.period, cls: ra.slot.cls, absentName: ra.slot.absentName }], manual);
      if (!x.ok) return { ...base, ok: false, cap, reason: x.issues.join(' ') };
      const sl = x.r.slots.find(s => s.key === key);
      const options = (sl.options || []).map(o => ({ id: o.id, name: o.name, reason: o.reason, debt: o.debt, pending: o.pending, consecutive: o.consecutive }));
      if (!sl || sl.status !== 'covered') return { ...base, ok: false, cap, options, reason: sl ? sl.reason : 'لا يوجد مرشح مؤهل.' };
      return { ...base, ok: true, cap, options, teacherId: sl.teacherId, teacherName: sl.teacherName, source: sl.source, kind: sl.kind,
        debtBefore: sl.debtBefore != null ? sl.debtBefore : (dep.state.debts || {})[sl.teacherId] || 0, manual: !!sl.manual, nextAfter: x.r.nextInRotationName || null, r: x.r, sl };
    }
    // ترتيب أولوية محرك القسم للعرض: الموصى به، ثم أصحاب الدين المتاحون، ثم الحقوق المعلقة، ثم ترتيب الدور من بعد المؤشر؛ وغير المتاحين آخرًا
    function rankOptions(d, dep, pr, recommended) {
      const st = settingsOf(dep);
      const ring = Engine.circularFrom(Engine.buildRing(teachersOf(d, dep.id), dep.headTeacherId), dep.state.pointer);
      const pos = id => { const i = ring.indexOf(id); return i < 0 ? 1e6 : i; };
      return (pr.options || []).slice().sort((a, b) => (a.id === recommended ? -1 : b.id === recommended ? 1 : 0)
        || (!!a.reason - !!b.reason) || (st.debt ? (b.debt > 0) - (a.debt > 0) || (b.debt - a.debt) : 0) || (b.pending - a.pending) || pos(a.id) - pos(b.id))
        .map(o => ({ ...o, recommended: o.id === recommended }));
    }
    function aaRecipients(d, dep, teacherId) {
      const recipients = [], missing = [];
      for (const a of d.accounts) if (a.status === 'active' && !a.revoked && a.deptId === dep.id && ['head', 'deputy'].includes(kindOf(a))) recipients.push({ id: a.id, name: a.name, role: kindOf(a) });
      if (!recipients.length) missing.push({ role: 'head', name: '—', why: 'لا يوجد حساب فعّال لرئيس القسم المستلم أو نوابه.' });
      const ta = d.accounts.find(a => kindOf(a) === 'teacher' && a.teacherId === teacherId && a.status === 'active' && !a.revoked);
      if (ta) recipients.push({ id: ta.id, name: ta.name, role: 'teacher' });
      else missing.push({ role: 'teacher', name: nameIn(d, teacherId), why: d.accounts.some(a => kindOf(a) === 'teacher' && a.teacherId === teacherId) ? 'حساب المعلم لم يُفعَّل بعد؛ لم يُسلَّم إشعاره الشخصي.' : 'لا يوجد حساب للمعلم في الموقع؛ لم يُسلَّم إشعاره الشخصي.' });
      return { recipients, missing };
    }
    const aaEvent = (d, ctx, e, kind, extra) => { const n = aaRecipients(d, deptIn(d, e.toDeptId), e.teacherId); (e.events = e.events || []).push({ id: uid('ev'), at: iso(), kind, by: ctx.name, recipients: n.recipients, missing: n.missing, ...(extra || {}) }); };
    const pickState = st => ({ debts: structuredClone(st.debts || {}), pointer: st.pointer || null, pending: structuredClone(st.pending || []), skips: (st.skips || []).slice(), earlyTurns: (st.earlyTurns || []).slice(), extraCredits: cleanCredits(st.extraCredits), pendingSeq: st.pendingSeq || 0, manualNext: st.manualNext || null });
    // إسناد حصة محالة إلى قسم ومعلم (teacherId فارغ = المرشح التلقائي للقسم). يُعدّل d مباشرة داخل المعاملة
    function applyAssign(d, ctx, refOrRa, deptId, teacherId, reason, how) {
      const ra = typeof refOrRa === 'object' ? refOrRa : referralOf(d, refOrRa); const ref = ra.ref;
      if (!ra.slot) fail('هذه الحصة لم تعد محالة إلى الإدارة (صُحّح يوم القسم المحيل). حدّث الصفحة.', 'conflict');
      if (!ra.schoolId) fail('القسم المحيل غير مرتبط بمدرسة.');
      const act = aaActive(d, ref);
      if (act && act.state === 'assigned') fail(`أُسندت هذه الحصة مسبقًا إلى «${act.teacherName}» (${act.toDeptName}).`, 'conflict');
      const dep = deptIn(d, deptId);
      if (!dep || dep.schoolId !== ra.schoolId) fail('القسم المستلم ليس من مدرسة الحصة.', 'forbidden');
      if (teacherId && !d.teachers.some(x => x.id === teacherId && x.deptId === dep.id)) fail('المعلم المختار ليس من معلمي القسم المستلم.');
      const pr = distProbe(d, ra, dep, teacherId || null, reason);
      if (!pr.ok) fail(`لا يمكن الإسناد إلى قسم «${dep.name}»: ${pr.reason}`);
      if (teacherId && pr.teacherId !== teacherId) fail('تعذّر تطبيق اختيار المعلم.');
      const sl = pr.sl, ns = pr.r.newState;
      const before = pickState(dep.state);
      const debtsAfter = {}; for (const k in ns.debts) if (ns.debts[k] > 0) debtsAfter[k] = ns.debts[k];
      const id = uid('aa');
      journal(dep, ctx, 'admin', dep.state.debts, debtsAfter, ra.date, id);
      // الرصيد الإضافي: وصول الدور إلى صاحبه أثناء إسناد حصة محالة يستهلكه كالتوزيع العادي (ويُرجَع عند إلغاء الإسناد)
      for (const c of pr.r.consumedCredits || []) creditLogAdd(dep, ctx, { kind: 'use', teacherId: c.teacherId, delta: -1, date: ra.date, aaId: id, period: c.period, cls: c.cls, note: `تم استيفاء الدور من الرصيد الإضافي — حصة محالة من قسم «${ra.src.name}» (الحصة ${c.period}، الصف ${c.cls})` });
      dep.state = { ...dep.state, debts: debtsAfter, pointer: ns.pointer, pending: ns.pending, skips: ns.skips, earlyTurns: (ns.earlyTurns || []).slice(), extraCredits: cleanCredits(ns.extraCredits), pendingSeq: ns.pendingSeq, manualNext: ns.manualNext };
      bump(dep);
      const sc = schoolIn(d, ra.schoolId); const rot = rotOf(sc);
      const e = {
        id, ref, schoolId: ra.schoolId, date: ra.date, srcDeptId: ra.src.id, srcDeptName: ra.src.name, slotKey: ra.key, period: ra.slot.period, cls: ra.slot.cls,
        absentId: ra.slot.absentId, absentName: ra.slot.absentName, state: 'assigned', how: how || 'manual', ...(ra.direct ? { direct: true } : {}),
        toDeptId: dep.id, toDeptName: dep.name, teacherId: sl.teacherId, teacherName: sl.teacherName, source: sl.source, kind: sl.kind,
        debtBefore: sl.source === 'debt' ? (before.debts[sl.teacherId] || 0) : null, debtAfter: sl.source === 'debt' ? (debtsAfter[sl.teacherId] || 0) : null,
        reason: sl.manual ? String(reason || '').trim().slice(0, 300) : '', exec: null,
        effect: { epoch: dep.state.epoch || 0, before, after: pickState(dep.state) },
        rot: { counted: rot.order.includes(dep.id), lastBefore: rot.last },
        by: ctx.name, byRole: ctx.role === 'admin' ? 'admin' : ctx.kind || ctx.role, at: iso(), events: []
      };
      if (act && act.state === 'uncoverable') { act.state = 'resolved'; act.resolvedBy = id; }
      d.adminAssigns = aaList(d).concat([e]);
      if (e.rot.counted) sc.adminRot = { order: rot.order, last: dep.id };
      aaEvent(d, ctx, e, 'assigned');
      const SRC_T = { debt: 'الدين', rotation: 'الدور' };
      audit(d, ctx, ra.direct ? 'تكليف مباشر من الإدارة' : 'إسناد حصة محالة من الإدارة', `${ra.date} — الحصة ${e.period} — الصف ${e.cls} (${ra.direct ? 'تكليف مباشر' : 'إحالة ' + e.srcDeptName}، غياب ${e.absentName}) ← ${e.teacherName} (${e.toDeptName}) — مصدر الاحتساب: ${SRC_T[e.source] || e.source}${e.debtBefore != null ? ` (الدين ${e.debtBefore} ← ${e.debtAfter})` : ''}${e.reason ? ' — السبب: ' + e.reason : ''}${how === 'auto' ? ' — توزيع تلقائي' : ''}`, dep.id);
      if (!ra.direct) audit(d, ctx, 'إسناد حصة محالة من الإدارة', `${ra.date} — الحصة ${e.period} — الصف ${e.cls} أُسندت إلى ${e.teacherName} (${e.toDeptName})`, ra.src.id);
      return e;
    }
    function cancelAssign(d, ctx, e, reason) {
      if (e.state !== 'assigned') fail('هذا التكليف ليس قائمًا.', 'conflict');
      if (e.exec === 'done') fail('التكليف مسجّل «نُفّذ فعليًا»؛ لا يُلغى بأثر رجعي. غيّر حالة التنفيذ أولًا إن كان التسجيل خطأ.', 'conflict');
      const dep = deptIn(d, e.toDeptId); const warnings = [];
      if ((dep.state.epoch || 0) === e.effect.epoch) {
        const ids = new Set(Object.keys(e.effect.before.debts).concat(Object.keys(e.effect.after.debts)));
        const rows = st => Array.from(ids).map(id => ({ id, remaining: st.debts[id] || 0 }));
        const mg = mergeDelta(d, dep, { debtRows: rows(e.effect.after), newState: e.effect.after }, { debtRows: rows(e.effect.before), newState: e.effect.before }, { debts: true, rotation: true });
        journal(dep, ctx, 'adminCancel', dep.state.debts, mg.stateAfter.debts, e.date, e.id);
        creditDiffLog(dep, ctx, dep.state.extraCredits, mg.stateAfter.extraCredits, 'correction', { date: e.date, aaId: e.id, note: 'إلغاء إسناد حصة محالة' });
        dep.state = { ...dep.state, ...mg.stateAfter };
        warnings.push(...mg.warnings);
      } else warnings.push('أُعيد ضبط الدين والدور في القسم المستلم بعد هذا التكليف؛ أُلغي التكليف دون إرجاع أثره إلى الدورة الجديدة.');
      bump(dep);
      const sc = schoolIn(d, e.schoolId); const rot = rotOf(sc);
      // دور الأقسام: يُرجَع فقط إن لم يتحرك بعد هذا التكليف
      if (e.rot && e.rot.counted) {
        if (rot.last === e.toDeptId && !aaList(d).some(x => x.schoolId === e.schoolId && x.at > e.at && x.state === 'assigned' && x.rot && x.rot.counted)) sc.adminRot = { order: rot.order, last: e.rot.lastBefore };
        else warnings.push('تحرك دور الأقسام بعد هذا التكليف، فبقي كما هو.');
      }
      e.state = 'cancelled'; e.cancelledAt = iso(); e.cancelledBy = ctx.name; e.cancelReason = String(reason || '').trim().slice(0, 300); e.cancelWarnings = warnings;
      aaEvent(d, ctx, e, 'cancelled');
      audit(d, ctx, 'إلغاء إسناد حصة محالة من الإدارة', `${e.date} — الحصة ${e.period} — الصف ${e.cls}: ${e.teacherName} (${e.toDeptName})${e.cancelReason ? ' — السبب: ' + e.cancelReason : ''}`, e.toDeptId);
      return warnings;
    }
    // قائمة الإحالات في مدرسة (من الأيام المعتمدة) مع حالة كل منها
    function referralsOf(d, sid, inRange, deptFilter) {
      const depIds = new Set(deptsOfSchool(d, sid).map(x => x.id));
      const items = []; const seen = new Set();
      for (const rec of d.days) {
        if (!depIds.has(rec.deptId) || !inRange(rec.date) || (deptFilter && rec.deptId !== deptFilter)) continue;
        for (const s0 of (rec.result && rec.result.slots) || []) if (s0.status === 'admin') {
          const ref = refOf(rec.deptId, rec.date, s0.key); seen.add(ref);
          items.push({ ref, date: rec.date, dayKey: rec.dayKey, srcDeptId: rec.deptId, srcDeptName: (deptIn(d, rec.deptId) || {}).name || '—', period: s0.period, cls: s0.cls, absentName: s0.absentName });
        }
      }
      // إحالات أُلغيت من القسم المحيل بعد أن تعاملت معها الإدارة
      for (const e of aaList(d)) if (e.schoolId === sid && !seen.has(e.ref) && inRange(e.date) && (!deptFilter || e.srcDeptId === deptFilter || (e.direct && e.toDeptId === deptFilter))) {
        seen.add(e.ref); items.push({ ref: e.ref, date: e.date, dayKey: Engine.dayKeyOf(e.date), srcDeptId: e.srcDeptId, srcDeptName: e.srcDeptName, period: e.period, cls: e.cls, absentName: e.absentName, ...(e.direct ? { direct: true } : { gone: true }) });
      }
      const view = e => e && { id: e.id, state: e.state, toDeptId: e.toDeptId, toDeptName: e.toDeptName, teacherId: e.teacherId, teacherName: e.teacherName, source: e.source, kind: e.kind, debtBefore: e.debtBefore, debtAfter: e.debtAfter,
        exec: e.exec, execName: e.exec ? AA_EXEC[e.exec] : null, how: e.how, by: e.by, at: e.at, reason: e.reason, reasons: e.reasons || null,
        notify: e.events && e.events.length ? { at: e.events[e.events.length - 1].at, kind: e.events[e.events.length - 1].kind, recipients: e.events[e.events.length - 1].recipients.map(r => ({ name: r.name, role: r.role })), missing: e.events[e.events.length - 1].missing } : null };
      for (const it of items) {
        const hist = aaList(d).filter(x => x.ref === it.ref);
        const act = hist.find(x => x.state === 'assigned' || x.state === 'uncoverable') || null;
        it.status = it.gone ? 'cancelled' : act ? act.state : it.direct ? 'cancelled' : 'pending';
        it.statusName = AA_NAMES[it.status];
        it.active = view(act);
        it.history = hist.filter(x => x !== act).map(view);
      }
      return items.sort((x, y) => (x.date === y.date ? (x.period === y.period ? (x.srcDeptName < y.srcDeptName ? -1 : 1) : x.period - y.period) : x.date < y.date ? 1 : -1));
    }
    const rotView = (d, sid) => {
      const sc = schoolIn(d, sid); const rot = rotOf(sc); const ids = new Set(deptsOfSchool(d, sid).map(x => x.id));
      const nm = id => (deptIn(d, id) || {}).name || '—';
      const nx = rotNext(rot, ids);
      return { order: rot.order.filter(id => ids.has(id)).map(id => ({ id, name: nm(id) })), last: rot.last ? { id: rot.last, name: nm(rot.last) } : null, next: nx ? { id: nx, name: nm(nx) } : null,
        depts: deptsOfSchool(d, sid).map(x => ({ id: x.id, name: x.name })) };
    };

    op('adminDist.list', ['admin', 'school'], async (ctx, a) => {
      const sid = distSchool(ctx, a.schoolId);
      const { from, to, inRange } = rangeOf(a);
      const items = referralsOf(db, sid, inRange, a.deptId || null);
      const counts = {}; for (const k of Object.keys(AA_NAMES)) counts[k] = items.filter(x => x.status === k).length;
      return { from, to, items, counts, rot: rotView(db, sid), classes: schoolClasses(db, sid, kuwaitToday(now())) };
    });
    // تفاصيل إحالة: ترشيح كل قسم، وإن حُدد قسم: معلموه بترتيب أولوية محركه، وأثر اختيار معلم محدد قبل التأكيد
    op('adminDist.options', ['admin', 'school'], async (ctx, a) => {
      const ra = referralOf(db, a.ref);
      const sid = distSchool(ctx, ra.schoolId);
      if (ra.schoolId !== sid) fail('الحصة ليست من مدرستك.', 'forbidden');
      if (!ra.slot) fail('هذه الحصة لم تعد محالة إلى الإدارة.', 'conflict');
      const act = aaActive(db, a.ref);
      const SRCN = { debt: 'الدين', rotation: 'الدور' };
      const sum = pr => ({ deptId: pr.deptId, deptName: pr.deptName, ok: pr.ok, reason: pr.reason || null, teacherId: pr.teacherId || null, teacherName: pr.teacherName || null, source: pr.source || null, sourceName: SRCN[pr.source] || null,
        debt: pr.ok && pr.debtOn ? pr.debtBefore : null, debtOn: pr.debtOn, rotOn: pr.rotOn, next: pr.next, cap: pr.cap && pr.cap.on ? { limit: pr.cap.limit, own: pr.cap.own, incoming: pr.cap.incoming, left: pr.cap.left } : null });
      const rot = rotView(db, sid);
      const depts = deptsOfSchool(db, sid).filter(x => x.id !== ra.src.id).map(dep => sum(distProbe(db, ra, dep, null)));
      let dept = null;
      if (a.deptId) {
        const dep = deptIn(db, a.deptId); if (!dep || dep.schoolId !== sid) fail('القسم ليس من هذه المدرسة.', 'forbidden');
        const auto = distProbe(db, ra, dep, null);
        dept = { ...sum(auto), options: auto.options ? rankOptions(db, dep, auto, auto.teacherId) : [] };
        if (a.teacherId) {
          const pr = distProbe(db, ra, dep, a.teacherId, a.reason || (a.teacherId !== auto.teacherId ? 'اختيار الإدارة' : ''));
          const bypass = !auto.ok || auto.teacherId !== a.teacherId;
          dept.pick = pr.ok ? { teacherId: pr.teacherId, teacherName: pr.teacherName, source: pr.source, sourceName: SRCN[pr.source], kind: pr.kind, bypass,
            debtBefore: pr.source === 'debt' ? pr.debtBefore : null, debtAfter: pr.source === 'debt' ? pr.debtBefore - 1 : null, nextBefore: pr.next, nextAfter: pr.nextAfter }
            : { error: pr.reason, bypass };
        }
        const ids = new Set(rot.order.map(x => x.id));
        dept.rotEffect = ids.has(dep.id) ? { before: rot.next ? rot.next.name : null, after: (() => { const n = rotNext({ order: rot.order.map(x => x.id), last: dep.id }, ids); return n ? (deptIn(db, n) || {}).name : null; })() } : { notParticipant: true };
      }
      return { referral: { ref: ra.ref, date: ra.date, period: ra.slot.period, cls: ra.slot.cls, srcDeptName: ra.src.name, absentName: ra.slot.absentName }, active: act ? { state: act.state, teacherName: act.teacherName, toDeptName: act.toDeptName } : null, depts, dept, rot };
    });
    op('adminDist.assign', ['admin', 'school'], async (ctx, a) => tx(d => {
      const ra = referralOf(d, a.ref); const sid = distSchool(ctx, ra.schoolId);
      if (ra.schoolId !== sid) fail('الحصة ليست من مدرستك.', 'forbidden');
      if (typeof a.teacherId !== 'string' || !a.teacherId) fail('اختر معلمًا من القسم المستلم.');
      const e = applyAssign(d, ctx, a.ref, a.deptId, a.teacherId, a.reason, 'manual');
      return { assignment: structuredClone(e) };
    }));
    /* تكليف مباشر من الإدارة: تكتب الإدارة التاريخ والحصة والصف (واسم الغائب اختياريًا) وتختار أي معلم في المدرسة.
       يُحتسب على المعلم في قسمه بقواعد محركه (الدين −1 إن كان عليه دين، وإلا الدور أو الدور المبكر)، ويُمنع إن كان مشغولًا في الحصة نفسها. */
    function directRa(d, sid, a) {
      const date = String(a.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Engine.dayKeyOf(date)) fail('اختر التاريخ.');
      const period = Number(a.period);
      if (!Number.isInteger(period) || period < 1 || period > 12) fail('اختر رقم الحصة.');
      const cls = String(a.cls || '').trim().replace(/\s+/g, '');
      if (!cls || cls.length > 20) fail('اكتب الصف، مثل 8/4.');
      const absentName = String(a.absentName || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const key = 'dir|' + period + '|' + cls;
      return { ref: 'dir§' + date + '§' + uid('dr'), direct: true, src: { id: null, name: 'الإدارة' }, slot: { period, cls, absentName: absentName || '—', absentId: null, key }, date, key, schoolId: sid };
    }
    const sameCls = (x, y) => String(x).replace(/[-\\]/g, '/') === String(y).replace(/[-\\]/g, '/');
    function directDup(d, ra) {
      const x = aaList(d).find(e => e.state === 'assigned' && e.schoolId === ra.schoolId && e.date === ra.date && e.period === ra.slot.period && sameCls(e.cls, ra.slot.cls));
      if (x) fail(`الحصة ${x.period} — الصف ${x.cls} لها تكليف قائم: «${x.teacherName}» (${x.toDeptName}). ألغه أولًا إن أردت تغييره.`, 'conflict');
    }
    // صفوف المدرسة من جداول أقسامها السارية (8-4 و8/4 صف واحد)، مرتبة بالمرحلة ثم الشعبة
    const clsNorm = c => String(c == null ? '' : c).trim().replace(/\s+/g, '').replace(/[-\\]/g, '/');
    function schoolClasses(d, sid, date) {
      const set = new Set();
      for (const dep of deptsOfSchool(d, sid)) { const sch = SW.effAt(d, dep, date); for (const e of (sch && sch.entries) || []) if (e.type === 'teach' && e.cls) set.add(clsNorm(e.cls)); }
      const num = x => x.split('/').map(Number);
      return Array.from(set).filter(x => /^\d+\/\d+$/.test(x)).sort((x, y) => num(x)[0] - num(y)[0] || num(x)[1] - num(y)[1]);
    }
    // صاحب الحصة في جدول المدرسة: من يدرّس الصف في هذه الحصة من هذا اليوم
    function classOwner(d, sid, date, period, cls) {
      const dk = Engine.dayKeyOf(date); const c = clsNorm(cls); const out = [];
      for (const dep of deptsOfSchool(d, sid)) { const sch = SW.effAt(d, dep, date); for (const e of (sch && sch.entries) || []) if (e.day === dk && e.period === period && e.type === 'teach' && clsNorm(e.cls) === c) out.push({ teacherName: nameIn(d, e.teacherId), deptName: dep.name }); }
      return out;
    }
    op('adminDist.directOptions', ['admin', 'school'], async (ctx, a) => {
      const sid = distSchool(ctx, a.schoolId); const ra = directRa(db, sid, a);
      const SRCN = { debt: 'الدين', rotation: 'الدور' };
      const depts = deptsOfSchool(db, sid).map(dep => {
        const pr = distProbe(db, ra, dep, null);
        const ts = new Map(teachersOf(db, dep.id).map(t => [t.id, t]));
        const opts = pr.options ? rankOptions(db, dep, pr, pr.ok ? pr.teacherId : null).filter(o => ts.has(o.id)) : [];
        return { deptId: dep.id, deptName: dep.name, ok: pr.ok, reason: pr.ok ? null : pr.reason, recommendedId: pr.ok ? pr.teacherId : null, recommendedName: pr.ok ? pr.teacherName : null, sourceName: pr.ok ? SRCN[pr.source] : null,
          options: opts.map(o => ({ id: o.id, name: o.name, reason: o.reason || (o.consecutive ? 'غطّى الحصة السابقة لنفس الصف بالدور' : null), debt: o.debt, pending: o.pending, recommended: o.recommended })) };
      });
      let pick = null;
      if (a.teacherId) {
        const t = db.teachers.find(x => x.id === a.teacherId); const dep = t && deptIn(db, t.deptId);
        if (!dep || dep.schoolId !== sid) fail('المعلم ليس من هذه المدرسة.', 'forbidden');
        const auto = distProbe(db, ra, dep, null);
        const pr = distProbe(db, ra, dep, a.teacherId, String(a.reason || '').trim() || 'تكليف مباشر من الإدارة');
        pick = pr.ok ? { teacherId: pr.teacherId, teacherName: pr.teacherName, deptName: dep.name, source: pr.source, sourceName: SRCN[pr.source], kind: pr.kind, bypass: !auto.ok || auto.teacherId !== a.teacherId,
          debtBefore: pr.source === 'debt' ? pr.debtBefore : null, debtAfter: pr.source === 'debt' ? pr.debtBefore - 1 : null, nextBefore: pr.next, nextAfter: pr.nextAfter } : { error: pr.reason, deptName: dep.name };
      }
      const dup = aaList(db).find(e => e.state === 'assigned' && e.schoolId === sid && e.date === ra.date && e.period === ra.slot.period && sameCls(e.cls, ra.slot.cls));
      return { slot: { date: ra.date, period: ra.slot.period, cls: ra.slot.cls, absentName: ra.slot.absentName }, owners: classOwner(db, sid, ra.date, ra.slot.period, ra.slot.cls), depts, pick, existing: dup ? { teacherName: dup.teacherName, deptName: dup.toDeptName } : null };
    });
    op('adminDist.direct', ['admin', 'school'], async (ctx, a) => tx(d => {
      const sid = distSchool(ctx, a.schoolId); const ra = directRa(d, sid, a);
      if (typeof a.teacherId !== 'string' || !a.teacherId) fail('اختر المعلم.');
      const t = d.teachers.find(x => x.id === a.teacherId); const dep = t && deptIn(d, t.deptId);
      if (!dep || dep.schoolId !== sid) fail('المعلم ليس من هذه المدرسة.', 'forbidden');
      directDup(d, ra);
      const e = applyAssign(d, ctx, ra, dep.id, a.teacherId, String(a.reason || '').trim() || 'تكليف مباشر من الإدارة', 'direct');
      return { assignment: structuredClone(e) };
    }));
    op('adminDist.cancel', ['admin', 'school'], async (ctx, a) => tx(d => {
      const e = aaList(d).find(x => x.id === a.id); if (!e) fail('التكليف غير موجود.', 'not_found');
      if (distSchool(ctx, e.schoolId) !== e.schoolId) fail('غير مصرح.', 'forbidden');
      const warnings = cancelAssign(d, ctx, e, a.reason);
      return { ok: true, warnings };
    }));
    op('adminDist.exec', ['admin', 'school'], async (ctx, a) => tx(d => {
      const e = aaList(d).find(x => x.id === a.id); if (!e) fail('التكليف غير موجود.', 'not_found');
      if (distSchool(ctx, e.schoolId) !== e.schoolId) fail('غير مصرح.', 'forbidden');
      if (e.state !== 'assigned') fail('هذا التكليف ليس قائمًا.', 'conflict');
      const v = a.exec === 'done' || a.exec === 'not' ? a.exec : null;
      const before = e.exec; e.exec = v; e.execBy = ctx.name; e.execAt = iso();
      audit(d, ctx, 'تسجيل تنفيذ تكليف من الإدارة', `${e.date} — الحصة ${e.period} — ${e.teacherName}: ${before ? AA_EXEC[before] : 'غير مسجل'} ← ${v ? AA_EXEC[v] : 'غير مسجل'}`, e.toDeptId);
      return { ok: true };
    }));
    op('adminDist.uncoverable', ['admin', 'school'], async (ctx, a) => tx(d => {
      const ra = referralOf(d, a.ref); if (distSchool(ctx, ra.schoolId) !== ra.schoolId) fail('غير مصرح.', 'forbidden');
      if (!ra.slot) fail('هذه الحصة لم تعد محالة إلى الإدارة.', 'conflict');
      if (aaActive(d, a.ref)) fail('للحصة إسناد أو حالة «تعذرت التغطية» قائمة.', 'conflict');
      const reasons = deptsOfSchool(d, ra.schoolId).filter(x => x.id !== ra.src.id).map(dep => { const pr = distProbe(d, ra, dep, null); return pr.ok ? null : { deptName: dep.name, reason: pr.reason }; }).filter(Boolean);
      const e = { id: uid('aa'), ref: a.ref, schoolId: ra.schoolId, date: ra.date, srcDeptId: ra.src.id, srcDeptName: ra.src.name, slotKey: ra.key, period: ra.slot.period, cls: ra.slot.cls, absentId: ra.slot.absentId, absentName: ra.slot.absentName,
        state: 'uncoverable', reason: String(a.reason || '').trim().slice(0, 300), reasons, by: ctx.name, at: iso(), events: [] };
      d.adminAssigns = aaList(d).concat([e]);
      audit(d, ctx, 'تعذرت تغطية حصة محالة', `${ra.date} — الحصة ${e.period} — الصف ${e.cls} (${e.srcDeptName})${e.reason ? ' — ' + e.reason : ''}`, ra.src.id);
      return { ok: true };
    }));
    op('adminDist.reopen', ['admin', 'school'], async (ctx, a) => tx(d => {
      const e = aaList(d).find(x => x.id === a.id && x.state === 'uncoverable'); if (!e) fail('لا توجد حالة «تعذرت التغطية» لهذه الحصة.', 'not_found');
      if (distSchool(ctx, e.schoolId) !== e.schoolId) fail('غير مصرح.', 'forbidden');
      e.state = 'cancelled'; e.cancelledAt = iso(); e.cancelledBy = ctx.name;
      audit(d, ctx, 'إعادة فتح حصة محالة', `${e.date} — الحصة ${e.period} — الصف ${e.cls} (${e.srcDeptName})`, e.srcDeptId);
      return { ok: true };
    }));
    // إعادة محاولة تسليم الإشعارات لآخر حدث: يُضاف المستلمون المتاحون الآن فقط دون تكرار
    op('adminDist.renotify', ['admin', 'school'], async (ctx, a) => tx(d => {
      const e = aaList(d).find(x => x.id === a.id); if (!e || !e.events || !e.events.length) fail('لا يوجد إشعار لهذا التكليف.', 'not_found');
      if (distSchool(ctx, e.schoolId) !== e.schoolId) fail('غير مصرح.', 'forbidden');
      const ev = e.events[e.events.length - 1];
      const n = aaRecipients(d, deptIn(d, e.toDeptId), e.teacherId);
      const added = n.recipients.filter(r => !ev.recipients.some(x => x.id === r.id));
      ev.recipients = ev.recipients.concat(added); ev.missing = n.missing.filter(m => !ev.recipients.some(r => r.role === m.role && (m.role !== 'teacher' || r.role === 'teacher')));
      return { added: added.map(x => x.name), missing: ev.missing };
    }));
    /* التوزيع التلقائي بالدور بين الأقسام: لكل حصة يبدأ من القسم التالي في دور الإدارة، ويتجاوز القسم المتعذر دون استهلاك دوره،
       ويُحسب أثر كل إسناد قبل الحصة التالية (على نسخة في المعاينة، وعلى البيانات نفسها عند الاعتماد). */
    function autoPlan(d, ctx, sid, refs) {
      const sc = schoolIn(d, sid); const ids = new Set(deptsOfSchool(d, sid).map(x => x.id));
      const rot0 = rotOf(sc); const order = rot0.order.filter(id => ids.has(id));
      if (!order.length) fail('حدّد الأقسام المشاركة وترتيبها في «دور الأقسام» أولًا.');
      const list = Array.from(new Set((refs || []).map(String))).map(r => referralOf(d, r));
      for (const ra of list) { if (ra.schoolId !== sid) fail('حصة من مدرسة أخرى.', 'forbidden'); if (!ra.slot) fail('إحدى الحصص لم تعد محالة إلى الإدارة. حدّث الصفحة.', 'conflict'); if (aaActive(d, ra.ref)) fail(`الحصة ${ra.slot.period} — ${ra.slot.cls} (${ra.src.name}) لها إسناد أو حالة قائمة.`, 'conflict'); }
      list.sort((x, y) => (x.date === y.date ? x.slot.period - y.slot.period || (order.indexOf(x.src.id) - order.indexOf(y.src.id)) : x.date < y.date ? -1 : 1));
      const out = [];
      for (const ra of list) {
        const rot = rotOf(sc); const start = order.indexOf(rot.last);
        const seq = order.slice(start + 1).concat(order.slice(0, start + 1));
        const skipped = []; let done = null;
        for (const depId of seq) {
          const dep = deptIn(d, depId);
          const pr = distProbe(d, ra, dep, null);
          if (!pr.ok) { skipped.push({ deptName: dep.name, reason: pr.reason }); continue; }
          done = applyAssign(d, ctx, ra.ref, dep.id, null, '', 'auto');
          break;
        }
        out.push({ ref: ra.ref, date: ra.date, period: ra.slot.period, cls: ra.slot.cls, srcDeptName: ra.src.name, absentName: ra.slot.absentName, skipped,
          pick: done ? { deptId: done.toDeptId, deptName: done.toDeptName, teacherId: done.teacherId, teacherName: done.teacherName, source: done.source, debtBefore: done.debtBefore, debtAfter: done.debtAfter } : null });
      }
      return out;
    }
    op('adminDist.autoPlan', ['admin', 'school'], async (ctx, a) => {
      const sid = distSchool(ctx, a.schoolId);
      const sim = structuredClone(db);
      const plan = autoPlan(sim, ctx, sid, a.refs);
      return { plan, rotAfter: rotView(sim, sid), signature: JSON.stringify(plan.map(x => [x.ref, x.pick && x.pick.deptId, x.pick && x.pick.teacherId])) };
    });
    op('adminDist.autoApply', ['admin', 'school'], async (ctx, a) => tx(d => {
      const sid = distSchool(ctx, a.schoolId);
      const plan = autoPlan(d, ctx, sid, a.refs);
      if (JSON.stringify(plan.map(x => [x.ref, x.pick && x.pick.deptId, x.pick && x.pick.teacherId])) !== a.signature) fail('تغيّرت البيانات منذ عرض المسودة (تكليف أو غياب أو إعداد). أعد عرض المسودة قبل الاعتماد.', 'conflict');
      for (const x of plan) if (!x.pick) {
        const ra = referralOf(d, x.ref);
        d.adminAssigns = aaList(d).concat([{ id: uid('aa'), ref: x.ref, schoolId: sid, date: ra.date, srcDeptId: ra.src.id, srcDeptName: ra.src.name, slotKey: ra.key, period: ra.slot.period, cls: ra.slot.cls, absentId: ra.slot.absentId, absentName: ra.slot.absentName,
          state: 'uncoverable', reason: 'التوزيع التلقائي: لا يوجد مرشح في الأقسام المشاركة', reasons: x.skipped, by: ctx.name, at: iso(), events: [] }]);
      }
      return { plan, assigned: plan.filter(x => x.pick).length, uncoverable: plan.filter(x => !x.pick).length };
    }));
    op('adminDist.rotSave', ['admin', 'school'], async (ctx, a) => tx(d => {
      const sid = distSchool(ctx, a.schoolId); const sc = schoolIn(d, sid);
      const ids = new Set(deptsOfSchool(d, sid).map(x => x.id));
      const order = Array.from(new Set((Array.isArray(a.order) ? a.order : []).map(String)));
      if (order.some(id => !ids.has(id))) fail('قسم ليس من هذه المدرسة.', 'forbidden');
      const last = a.last ? String(a.last) : null;
      if (last && !order.includes(last)) fail('آخر قسم مستلم يجب أن يكون من الأقسام المشاركة.');
      const before = rotView(d, sid);
      sc.adminRot = { order, last };
      const nm = id => (deptIn(d, id) || {}).name;
      audit(d, ctx, 'تعديل دور الأقسام لتوزيع حصص الإدارة', `الترتيب: ${before.order.map(x => x.name).join(' ← ') || '—'} ⇐ ${order.map(nm).join(' ← ') || '—'}؛ آخر مستلم: ${before.last ? before.last.name : '—'} ⇐ ${last ? nm(last) : '—'}`, null);
      return { rot: rotView(d, sid) };
    }));
    // إشعارات الموقع لرئيس القسم ونوابه والمعلم: من أحداث تكليفات الإدارة الموجّهة لحسابه
    op('notice.list', ['head', 'teacher'], async ctx => {
      const acc = db.accounts.find(x => x.id === ctx.id) || {};
      const seen = acc.noticesSeenAt || '';
      const SRCN = { debt: 'الدين', rotation: 'الدور' };
      const items = [];
      for (const e of aaList(db)) for (const ev of e.events || []) if (ev.recipients.some(r => r.id === ctx.id)) {
        items.push({ seq: items.length, id: ev.id, at: ev.at, unread: ev.at > seen, kind: ev.kind,
          title: ev.kind === 'cancelled' ? 'إلغاء تكليف احتياط من الإدارة' : 'تكليف احتياط من الإدارة',
          date: e.date, dayName: Engine.DAY_NAMES[Engine.dayKeyOf(e.date)], period: e.period, cls: e.cls, teacherName: e.teacherName, deptName: e.toDeptName, srcDeptName: e.srcDeptName,
          sourceName: SRCN[e.source] || null, link: ctx.role === 'teacher' ? '#/home' : '#/today~' + e.date });
      }
      for (const x of SW.noticeItems(db, ctx, seen)) items.push({ seq: items.length, ...x, link: '#/mySchedule' });
      items.sort((x, y) => (x.at === y.at ? y.seq - x.seq : x.at < y.at ? 1 : -1));
      return { items: items.slice(0, 100), unread: items.filter(x => x.unread).length };
    });
    op('notice.seen', ['head', 'teacher'], async ctx => tx(d => {
      const acc = d.accounts.find(x => x.id === ctx.id); if (acc) acc.noticesSeenAt = iso();
      return { ok: true };
    }));

    // تقرير المدرسة: لكل قسم تقريره المستقل (لا تُخلط أرصدة الدين أو الدور بين الأقسام)، مع ملخص للمدرسة من التكليفات فقط
    op('school.report', ['admin', 'school'], async (ctx, a) => {
      const sid = schoolScope(ctx, a.schoolId); const sc = schoolIn(db, sid);
      const { from, to } = rangeOf(a);
      const allow = new Set(deptsFor(ctx, sid, 'school.report'));
      let deps = deptsOfSchool(db, sid).filter(x => allow.has(x.id));
      let teacher = null;
      if (a.teacherId) {
        teacher = db.teachers.find(t => t.id === a.teacherId);
        if (!teacher || !deps.some(x => x.id === teacher.deptId)) fail('اختر معلمًا من معلمي أقسام هذه المدرسة.');
        if (a.deptId && a.deptId !== teacher.deptId) fail('المعلم المختار ليس من القسم المحدد.');
        deps = deps.filter(x => x.id === teacher.deptId);
      } else if (a.deptId) { const id = scope(ctx, a.deptId); deps = deps.filter(x => x.id === id); if (!deps.length) fail('القسم ليس من هذه المدرسة.', 'forbidden'); }
      const parts = deps.map(dep => {
        const r = deptReport(dep, { from, to, type: a.type, teacherId: teacher ? teacher.id : null });
        // الحصة المحالة تُعدّ مرة واحدة في القسم المحيل؛ التكليف الوارد يظهر في القسم المستلم ولا يُضاف إلى حصصه المطلوبة
        const own = r.rows.filter(x => !x.fromAdmin);
        const covered = own.filter(x => x.status === 'covered'), ids = new Set(covered.map(x => x.id));
        return {
          deptId: dep.id, deptName: dep.name, settings: settingsOf(dep), needsSetup: !dep.headTeacherId || !srcLatest(dep, kuwaitToday(now())) || !dep.state.confirmed,
          overview: { days: r.days.length, slots: own.length, covered: ids.size, uncovered: own.filter(x => x.status === 'uncovered').length, transferred: own.filter(x => x.status === 'admin').length,
            adminAssigned: own.filter(x => x.status === 'admin' && x.adminTo && !x.adminTo.uncoverable).length, incoming: r.rows.filter(x => x.fromAdmin).length,
            corrections: r.corrections.length, absences: r.days.reduce((s1, x) => s1 + x.absentees.length, 0) },
          report: r
        };
      });
      const sum = k => parts.reduce((s1, x) => s1 + x.overview[k], 0);
      return {
        meta: { systemName: db.meta.systemName, schoolId: sid, schoolName: sc.name, deptId: a.deptId || (teacher ? teacher.deptId : null), teacherId: teacher ? teacher.id : null, teacherName: teacher ? teacher.name : null, from, to, generatedAt: iso(), type: a.type === 'summary' ? 'summary' : 'detail' },
        overview: { departments: parts.length, days: sum('days'), slots: sum('slots'), covered: sum('covered'), uncovered: sum('uncovered'), transferred: sum('transferred'), adminAssigned: sum('adminAssigned'), corrections: sum('corrections') },
        notes: ['أرصدة الدين خاصة بكل قسم ولا تُجمع على مستوى المدرسة.'].concat(parts.some(x => x.report.notes.some(n => n.kind === 'warn')) ? ['في بعض الأقسام أيام ممسوحة أو بيانات غير مكتملة؛ راجع ملاحظات كل قسم.'] : []),
        depts: parts
      };
    });

    // ---------- استيراد جدول المدرسة ----------
    // السياق: أقسام المدرسة ومعلموها وجداولها المعتمدة وإعدادات التنسيق المحفوظة (القراءة فقط)
    // استيراد جدول المدرسة الشامل مؤجل إلى طلب منفصل: العمليات موجودة لكنها موقوفة في هذه النسخة
    const importOff = () => { if (!(opts.features && opts.features.schoolImport)) fail('استيراد جدول المدرسة الشامل مؤجل إلى مرحلة لاحقة.', 'disabled'); };
    op('schoolImport.context', ['admin', 'school'], async (ctx, a) => {
      importOff();
      const sid = schoolScope(ctx, a.schoolId); const sc = schoolIn(db, sid);
      return {
        school: { id: sc.id, name: sc.name }, profile: sc.importProfile ? structuredClone(sc.importProfile) : null,
        depts: deptsOfSchool(db, sid).map(dep => ({
          id: dep.id, name: dep.name, status: dep.status, headTeacherId: dep.headTeacherId || null,
          approved: dep.scheduleApproved ? structuredClone(dep.scheduleApproved) : null, scheduleVersion: dep.scheduleApproved ? dep.scheduleApproved.version : 0,
          teachers: teachersOf(db, dep.id).map(t => ({ id: t.id, name: t.name, status: t.status, inRotation: t.inRotation, isHead: dep.headTeacherId === t.id }))
        }))
      };
    });
    // حفظ إعدادات التنسيق لإعادة استخدامها (لا تُطبَّق على ملف جديد إلا بعد التحقق من توافقه في المعالج)
    op('schoolImport.profileSave', ['admin', 'school'], async (ctx, a) => tx(d => {
      importOff();
      const sid = schoolScope(ctx, a.schoolId); const sc = schoolIn(d, sid);
      const p = a.profile || {};
      if (JSON.stringify(p).length > 400000) fail('إعدادات الاستيراد أكبر من المسموح.');
      const depIds = new Set(deptsOfSchool(d, sid).map(x => x.id));
      const tIds = new Set(d.teachers.filter(t => depIds.has(t.deptId)).map(t => t.id));
      const str = (v, n) => String(v == null ? '' : v).slice(0, n);
      const num = x => (Number.isInteger(x) && x >= 0 && x < 100000 ? x : null);
      const c = p.cfg || {};
      const cfg = {
        orientation: c.orientation === 'cols' ? 'cols' : 'rows',
        range: c.range && ['r1', 'c1', 'r2', 'c2'].every(k => num(c.range[k]) != null) ? { r1: c.range.r1, c1: c.range.c1, r2: c.range.r2, c2: c.range.c2 } : null,
        nameLine: num(c.nameLine), dayMode: c.dayMode === 'fixed' ? 'fixed' : 'header', fixedDay: Engine.DAY_KEYS.includes(c.fixedDay) ? c.fixedDay : null,
        dayLine: num(c.dayLine), dayFill: c.dayFill === 'carry' ? 'carry' : 'merge', periodLine: num(c.periodLine), dataStart: num(c.dataStart),
        classPattern: ['slash', 'dash', 'slashdash', 'letter', 'none'].includes(c.classPattern) ? c.classPattern : 'slash',
        classMatch: c.classMatch === 'inside' ? 'inside' : 'whole', mergedData: c.mergedData === 'span' ? 'span' : 'error'
      };
      const deptMode = ['column', 'sheets', 'groups', 'manual'].includes(p.deptMode) ? p.deptMode : 'column';
      const map = (o, f) => { const out = {}; for (const [k, v] of Object.entries(o && typeof o === 'object' ? o : {}).slice(0, 3000)) { const x = f(v); if (x != null) out[str(k, 200)] = x; } return out; };
      const prof = {
        sheets: (Array.isArray(p.sheets) ? p.sheets : []).slice(0, 60).map(x => str(x, 100)), cfg, deptMode,
        deptLine: num(p.deptLine), deptCarry: p.deptCarry !== false,
        sheetDepts: map(p.sheetDepts, v => str(v, 120) || null),
        deptLinks: map(p.deptLinks, v => (v === '__new__' || v === '__skip__' || depIds.has(v) ? v : null)),
        teacherLinks: map(p.teacherLinks, v => (v === '__new__' || v === '__exclude__' || tIds.has(v) ? v : null)),
        manualDepts: map(p.manualDepts, v => str(v, 120) || null),
        codes: map(p.codes, v => (v && (v.type === 'ignore' || Engine.SLOT_TYPES[v.type]) ? { type: v.type, cls: v.type === 'teach' ? str(v.cls, 30) : '' } : null)),
        signature: { slots: num((p.signature || {}).slots), sheets: num((p.signature || {}).sheets) },
        savedAt: iso(), savedBy: ctx.name
      };
      sc.importProfile = prof;
      audit(d, ctx, 'حفظ إعدادات استيراد جدول المدرسة', `${deptMode} — ${Object.keys(prof.deptLinks).length} ربط قسم، ${Object.keys(prof.teacherLinks).length} ربط معلم`, null, { schoolId: sid });
      return { ok: true };
    }));
    /* اعتماد جدول قسم واحد من ملف المدرسة (معاملة مستقلة لكل قسم، فالاعتماد الجزئي واضح):
       - قسم قائم من المدرسة نفسها، أو قسم جديد يُنشأ في المدرسة.
       - المعلمون: إما سجل قائم في القسم نفسه (لا يُنقل معلم من قسم آخر)، أو سجل جديد (دون حساب دخول).
       - إصدار جديد للجدول؛ لا يُمس الدين ولا الدور ولا الأيام المعتمدة. */
    op('schoolImport.applyDept', ['admin', 'school'], async (ctx, a) => tx(d => {
      importOff();
      const sid = schoolScope(ctx, a.schoolId);
      let dep, created = false;
      if (a.deptId) {
        dep = deptIn(d, scope(ctx, a.deptId));
        if (dep.schoolId !== sid) fail('القسم ليس من هذه المدرسة.', 'forbidden');
        const cur = dep.scheduleApproved ? dep.scheduleApproved.version : 0;
        if ((a.baseVersion || 0) !== cur) fail(`اعتُمد إصدار آخر من جدول قسم «${dep.name}» منذ بدء هذا الاستيراد. أعد قراءة الملف ومراجعة الفروقات.`, 'conflict');
      } else { dep = newDept(d, ctx, cleanName(a.newName, 'اسم القسم'), sid); created = true; }
      const list = Array.isArray(a.teachers) ? a.teachers : [];
      if (!list.length) fail('لا يوجد معلمون في جدول هذا القسم.');
      if (list.length > 400) fail('عدد المعلمين أكبر من المسموح.');
      const idOf = new Map(); const used = new Set(); let added = 0;
      for (const t of list) {
        const key = String((t && t.key) || ''); if (!key || idOf.has(key)) fail('بيانات المعلمين غير صالحة (مفتاح مكرر أو فارغ).');
        if (t.teacherId) {
          const ex = d.teachers.find(x => x.id === t.teacherId);
          if (!ex || ex.deptId !== dep.id) fail(`المعلم «${String(t.name || '')}» مرتبط بسجل ليس من قسم «${dep.name}». لا يُنقل المعلم بين الأقسام تلقائيًا؛ راجع الربط.`);
          if (used.has(ex.id)) fail(`أكثر من اسم في الملف مرتبط بالمعلم «${ex.name}».`);
          used.add(ex.id); idOf.set(key, ex.id);
        } else {
          const name = cleanName(t.name, 'اسم المعلم');
          if (teachersOf(d, dep.id).some(x => x.name === name)) fail(`يوجد في قسم «${dep.name}» معلم باسم «${name}». اربط الاسم بالسجل القائم أو ميّزه، بدل إنشاء سجل مكرر.`);
          const order = teachersOf(d, dep.id).reduce((m, x) => Math.max(m, x.rotationOrder), 0) + 1;
          const nt = { id: uid('t'), deptId: dep.id, name, status: 'active', inRotation: true, rotationOrder: order, demo: false, createdAt: iso() };
          d.teachers.push(nt); idOf.set(key, nt.id); used.add(nt.id); added++;
        }
      }
      const p = a.payload || {};
      const payload = { days: p.days, periodsByDay: p.periodsByDay, teacherIds: list.map(t => idOf.get(String(t.key))),
        entries: (Array.isArray(p.entries) ? p.entries : []).map(e => ({ ...e, teacherId: idOf.get(String(e && e.teacherKey)) || '__unknown__' })) };
      const clean = validateSchedulePayload(payload, new Set(teachersOf(d, dep.id).map(t => t.id)));
      if (!created) excelOverTimetable(d, ctx, dep, a);
      const src = a.source || {};
      const cur = dep.scheduleApproved ? dep.scheduleApproved.version : 0;
      const v = {
        version: cur + 1, approvedAt: iso(), approvedBy: ctx.name, ...clean,
        source: { kind: 'school-excel', fileName: str0(src.fileName, 160), sheet: str0(src.sheet, 100), fileSize: Number(src.fileSize) || null, mode: 'school' }
      };
      addScheduleVersion(dep, v); bump(dep);
      audit(d, ctx, 'اعتماد جدول القسم من جدول المدرسة', `${created ? 'قسم جديد — ' : ''}الإصدار ${v.version} — ${v.source.fileName} — ${v.entries.length} خانة، ${v.teacherIds.length} معلم${added ? `، ${added} سجل معلم جديد (دون حسابات دخول)` : ''}`, dep.id, { schoolId: sid });
      return { deptId: dep.id, deptName: dep.name, created, version: v.version, teachersAdded: added, needsSetup: !dep.headTeacherId || !dep.state.confirmed };
    }));
    const str0 = (v, n) => String(v == null ? '' : v).slice(0, n);

    // ================= التفويضات =================
    const DLG_STATE = { active: 'سارٍ', scheduled: 'لم يبدأ بعد', expired: 'منتهٍ', revoked: 'ملغى', suspended: 'معلّق للمراجعة', inactive: 'غير فعّال (حساب المفوَّض)' };
    const permNames = keys => keys.map(k => (PERMS.find(x => x.key === k) || {}).label || k);
    // المرشحون: حسابات رؤساء الأقسام ونوابهم في أقسام المدرسة (التفويض لا ينشئ حسابًا ولا يغيّر الدور الأصلي)
    const candidatesOf = (d, sid) => d.accounts.filter(x => !SCHOOL_KINDS.includes(x.kind) && x.kind !== 'teacher' && x.status !== 'disabled' && !x.revoked && (deptIn(d, x.deptId) || {}).schoolId === sid)
      .map(x => ({ id: x.id, name: x.name, kind: x.kind === 'deputy' ? 'deputy' : 'head', kindName: KIND_NAMES[x.kind === 'deputy' ? 'deputy' : 'head'], deptId: x.deptId, deptName: deptIn(d, x.deptId).name, status: x.status }));
    function dlgView(d, g, today) {
      const ge = d.accounts.find(x => x.id === g.granteeId); const gd = ge ? deptIn(d, ge.deptId) : null;
      return {
        id: g.id, granteeId: g.granteeId, granteeName: ge ? ge.name : '—', granteeKind: ge ? KIND_NAMES[ge.kind === 'deputy' ? 'deputy' : 'head'] : '', granteeDept: gd ? gd.name : '—',
        grantorId: g.grantorId, grantorName: g.grantorName, perms: g.perms.slice(), permNames: permNames(g.perms),
        allDepts: !!g.allDepts, deptIds: (g.deptIds || []).slice(), deptNames: g.allDepts ? ['المدرسة كلها'] : (g.deptIds || []).map(id => (deptIn(d, id) || {}).name || '—'),
        startDate: g.startDate, endDate: g.endDate || null, note: g.note || '', status: g.status, state: delegationState(d, g, today), stateName: DLG_STATE[delegationState(d, g, today)],
        suspendReason: g.suspendReason || null, createdAt: g.createdAt, updatedAt: g.updatedAt || null, history: (g.history || []).slice()
      };
    }
    // من يدير التفويضات: المنظّم، ومدير المدرسة ومساعدوه لمدرستهم. المفوَّض لا يمنح ولا يعدّل تفويضًا (ولا تفويضه)
    op('delegation.list', ['admin', 'school'], async (ctx, a) => {
      const sid = schoolScope(ctx, a.schoolId); const sc = schoolIn(db, sid); const today = kuwaitToday(now());
      return {
        school: { id: sc.id, name: sc.name }, today, perms: PERMS.map(x => ({ ...x, needs: x.needs || [] })),
        depts: deptsOfSchool(db, sid).map(x => ({ id: x.id, name: x.name })), candidates: candidatesOf(db, sid),
        delegations: (db.delegations || []).filter(g => g.schoolId === sid).map(g => dlgView(db, g, today)).reverse()
      };
    });
    function cleanDelegation(d, sid, a) {
      const cand = candidatesOf(d, sid).find(x => x.id === a.granteeId);
      if (!cand) fail('اختر مستخدمًا لديه حساب في أحد أقسام هذه المدرسة (رئيس قسم أو نائب رئيس قسم).');
      const perms = Array.from(new Set(Array.isArray(a.perms) ? a.perms.map(String) : []));
      if (!perms.length) fail('اختر صلاحية واحدة على الأقل.');
      for (const k of perms) if (!PERM_KEYS.includes(k)) fail('صلاحية غير معروفة.');
      for (const k of perms) for (const n0 of (PERMS.find(x => x.key === k).needs || [])) if (!perms.includes(n0)) fail(`صلاحية «${permNames([k])[0]}» تتطلب «${permNames([n0])[0]}».`);
      const allDepts = a.scope !== 'depts';
      if (!allDepts && perms.some(k => (PERMS.find(x => x.key === k) || {}).schoolWide)) fail('صلاحيات «جدول المدرسة» على مستوى المدرسة؛ اختر نطاق «المدرسة كلها».');
      const deptIds = allDepts ? [] : Array.from(new Set(Array.isArray(a.deptIds) ? a.deptIds.map(String) : []));
      if (!allDepts && !deptIds.length) fail('اختر قسمًا واحدًا على الأقل، أو «المدرسة كلها».');
      for (const id of deptIds) { const x = deptIn(d, id); if (!x || x.schoolId !== sid) fail('أحد الأقسام المختارة ليس من هذه المدرسة.', 'forbidden'); }
      const startDate = String(a.startDate || ''); if (!isDateStr(startDate)) fail('حدّد تاريخ البداية.');
      const endDate = a.endDate ? String(a.endDate) : null;
      if (endDate && !isDateStr(endDate)) fail('صيغة تاريخ النهاية غير صحيحة.');
      if (endDate && endDate < startDate) fail('تاريخ النهاية يسبق تاريخ البداية.');
      return { granteeId: cand.id, perms: PERM_KEYS.filter(k => perms.includes(k)), allDepts, deptIds, startDate, endDate, note: String(a.note || '').trim().slice(0, 300), cand };
    }
    const grantorOf = ctx => (ctx.role === 'admin' ? { grantorId: 'admin', grantorName: ctx.name + ' (مدير النظام)' } : { grantorId: ctx.id, grantorName: `${ctx.name} (${KIND_NAMES[ctx.kind]})` });
    const scopeTxt = c => (c.allDepts ? 'المدرسة كلها' : c.deptIds.map(id => (deptIn(db, id) || {}).name || '—').join('، '));
    op('delegation.save', ['admin', 'school'], async (ctx, a) => tx(d => {
      const sid = schoolScope(ctx, a.schoolId);
      const c = cleanDelegation(d, sid, a);
      const by = ctx.name; const at = iso();
      const snap = { perms: c.perms, allDepts: c.allDepts, deptIds: c.deptIds, startDate: c.startDate, endDate: c.endDate, note: c.note };
      d.delegations = d.delegations || [];
      if (a.id) {
        const g = d.delegations.find(x => x.id === a.id && x.schoolId === sid);
        if (!g) fail('التفويض غير موجود في هذه المدرسة.', 'not_found');
        if (g.status === 'revoked') fail('التفويض ملغى؛ أنشئ تفويضًا جديدًا بدل تعديله.');
        if (g.granteeId !== c.granteeId) fail('لا يُغيَّر المفوَّض في تفويض قائم؛ ألغِه وأنشئ تفويضًا جديدًا.');
        Object.assign(g, snap, { updatedAt: at });
        g.history = (g.history || []).concat([{ at, by, action: 'تعديل', ...snap }]);
        audit(d, ctx, 'تعديل تفويض', `${c.cand.name}: ${permNames(c.perms).join('، ')} — ${scopeTxt(c)} — من ${c.startDate}${c.endDate ? ' إلى ' + c.endDate : ' حتى الإلغاء'}`, null, { schoolId: sid, delegationId: g.id });
        return { id: g.id };
      }
      const g = { id: uid('dlg'), schoolId: sid, granteeId: c.granteeId, ...grantorOf(ctx), ...snap, status: 'active', createdAt: at, updatedAt: null, history: [{ at, by, action: 'منح', ...snap }] };
      d.delegations.push(g);
      audit(d, ctx, 'منح تفويض', `${c.cand.name} (${c.cand.kindName} — ${c.cand.deptName}): ${permNames(c.perms).join('، ')} — ${scopeTxt(c)} — من ${c.startDate}${c.endDate ? ' إلى ' + c.endDate : ' حتى الإلغاء'}`, null, { schoolId: sid, delegationId: g.id });
      return { id: g.id };
    }));
    op('delegation.revoke', ['admin', 'school'], async (ctx, a) => tx(d => {
      const sid = schoolScope(ctx, a.schoolId);
      const g = (d.delegations || []).find(x => x.id === a.id && x.schoolId === sid); if (!g) fail('التفويض غير موجود في هذه المدرسة.', 'not_found');
      if (g.status === 'revoked') return { ok: true };
      const at = iso(); g.status = 'revoked'; g.revokedAt = at; g.revokedBy = ctx.name; g.updatedAt = at;
      g.history = (g.history || []).concat([{ at, by: ctx.name, action: 'إلغاء' }]);
      const ge = d.accounts.find(x => x.id === g.granteeId);
      audit(d, ctx, 'إلغاء تفويض', `${ge ? ge.name : '—'}: ${permNames(g.perms).join('، ')}`, null, { schoolId: sid, delegationId: g.id });
      return { ok: true };
    }));
    // استئناف تفويض معلّق بعد مراجعته: يصبح المراجِع هو المانح المسؤول عنه
    op('delegation.resume', ['admin', 'school'], async (ctx, a) => tx(d => {
      const sid = schoolScope(ctx, a.schoolId);
      const g = (d.delegations || []).find(x => x.id === a.id && x.schoolId === sid); if (!g) fail('التفويض غير موجود في هذه المدرسة.', 'not_found');
      if (g.status !== 'suspended' && delegationState(d, g, kuwaitToday(now())) !== 'suspended') fail('التفويض ليس معلّقًا.');
      const at = iso(); const prev = g.grantorName;
      Object.assign(g, grantorOf(ctx), { status: 'active', suspendReason: null, updatedAt: at });
      g.history = (g.history || []).concat([{ at, by: ctx.name, action: `استئناف بعد المراجعة (المانح السابق: ${prev})` }]);
      audit(d, ctx, 'استئناف تفويض معلّق', `${prev} ← ${g.grantorName}`, null, { schoolId: sid, delegationId: g.id });
      return { ok: true };
    }));
    // تعليق تفويضات حساب مانح عند تعطيله أو نقله لمدرسة أخرى (تبقى في السجل، وتُستأنف بالمراجعة فقط)
    function suspendGrantsBy(d, accId, reason, ctx) {
      for (const g of (d.delegations || []).filter(x => x.grantorId === accId && x.status === 'active')) {
        g.status = 'suspended'; g.suspendReason = reason; g.updatedAt = iso();
        g.history = (g.history || []).concat([{ at: iso(), by: ctx.name, action: 'تعليق: ' + reason }]);
        audit(d, ctx, 'تعليق تفويض', reason, null, { schoolId: g.schoolId, delegationId: g.id });
      }
    }

    // -- السجل --
    op('audit.list', ['admin', 'head'], async (ctx, a) => {
      let list = db.audit;
      if (ctx.role === 'head') { const id = scope(ctx, a.deptId); list = list.filter(x => x.deptId === id); }
      else if (ctx.role === 'school') {
        if (a.deptId) { const id = scope(ctx, a.deptId); list = list.filter(x => x.deptId === id); }
        else { const ids = new Set(deptsOfSchool(db, ctx.schoolId).map(x => x.id)); list = list.filter(x => (x.deptId && ids.has(x.deptId)) || (!x.deptId && x.schoolId === ctx.schoolId)); }
      }
      else if (a.deptId) list = list.filter(x => x.deptId === a.deptId);
      else if (a.schoolId) { const ids = new Set(deptsOfSchool(db, a.schoolId).map(x => x.id)); list = list.filter(x => (x.deptId && ids.has(x.deptId)) || x.schoolId === a.schoolId); }
      const names = Object.fromEntries(db.departments.map(x => [x.id, x.name]));
      return list.slice(-300).reverse().map(x => ({ ...x, deptName: x.deptId ? names[x.deptId] || '—' : '' }));
    });

    // -- بيانات المحاكاة --
    op('demo.create', ['admin'], async ctx => {
      if (production) fail('القسم التجريبي غير متاح في نسخة الإنتاج حتى لا تختلط بيانات تجريبية بالبيانات الفعلية.', 'forbidden');
      if (db.departments.some(x => x.demo)) fail('القسم التجريبي موجود مسبقًا.');
      return tx(d => {
        const dep = {
          id: uid('dep'), name: 'قسم تجريبي (بيانات اصطناعية)', school: '', status: 'active', headTeacherId: null,
          deputyTeacherIds: [], scheduleApproved: null, scheduleVersions: [], importProfile: null, exclusions: [],
          state: { confirmed: true, debts: {}, pointer: null, pending: [], skips: [], pendingSeq: 0, manualNext: null, version: 1, openingSource: 'fresh' }, backups: [], debtJournal: [], legacyMaxDate: null, journalSince: iso(), demo: true, createdAt: iso()
        };
        d.departments.push(dep);
        const ts = [];
        for (let i = 1; i <= 6; i++) { const t = { id: uid('t'), deptId: dep.id, name: `معلم تجريبي ${i}`, status: 'active', inRotation: true, rotationOrder: i, demo: true, createdAt: iso() }; d.teachers.push(t); ts.push(t); }
        dep.headTeacherId = ts[0].id;
        dep.deputyTeacherIds = [ts[1].id];
        const cls = ['6/1', '6/2', '7/1', '7/2', '8/1', '8/2', '9/1', '9/2'];
        // أعداد حصص مختلفة بين الأيام (بيانات اصطناعية للتجربة فقط)
        const periodsByDay = { sun: [1, 2, 3, 4, 5, 6, 7], mon: [1, 2, 3, 4, 5, 6, 7], tue: [1, 2, 3, 4, 5, 6], wed: [1, 2, 3, 4, 5, 6, 7], thu: [1, 2, 3, 4, 5] };
        const days = Object.keys(periodsByDay);
        const entries = [];
        let k = 0;
        days.forEach((day, di) => {
          ts.forEach((t, ti) => {
            for (const p of periodsByDay[day]) {
              if (ti === 2 && (p === 4 || p === 5)) continue;
              if (ti === 0 && p > 2) continue;
              const v = (p + ti * 2 + di) % 4;
              if (v === 0) entries.push({ teacherId: t.id, day, period: p, type: 'teach', cls: cls[(k++) % cls.length], raw: '', ref: '' });
              else if (v === 1 && p % 3 === 0) entries.push({ teacherId: t.id, day, period: p, type: 'meeting', cls: '', raw: '', ref: '' });
            }
          });
          // حصتان متتاليتان لنفس الصف للتجربة
          entries.push({ teacherId: ts[2].id, day, period: 4, type: 'teach', cls: '8/3', raw: '', ref: '' }, { teacherId: ts[2].id, day, period: 5, type: 'teach', cls: '8/3', raw: '', ref: '' });
        });
        dep.scheduleApproved = { version: 1, approvedAt: iso(), approvedBy: 'بيانات اصطناعية', days, periodsByDay, teacherIds: ts.map(t => t.id), entries, source: { kind: 'demo', note: 'جدول اصطناعي مولّد للتجربة' } };
        dep.scheduleVersions = [dep.scheduleApproved];
        audit(d, ctx, 'إنشاء قسم تجريبي', 'بيانات اصطناعية معلّمة', dep.id);
        return { id: dep.id };
      });
    });
    op('demo.remove', ['admin'], async ctx => tx(d => {
      const ids = new Set(d.departments.filter(x => x.demo).map(x => x.id));
      d.departments = d.departments.filter(x => !ids.has(x.id));
      d.teachers = d.teachers.filter(x => !ids.has(x.deptId));
      d.days = d.days.filter(x => !ids.has(x.deptId));
      d.audit = d.audit.filter(x => !ids.has(x.deptId));
      for (const a of d.accounts) if (ids.has(a.deptId)) { a.status = 'disabled'; a.code = null; }
      d.sessions = d.sessions.filter(s => !d.accounts.some(a => a.id === s.accountId && a.status === 'disabled'));
      audit(d, ctx, 'حذف القسم التجريبي وبياناته');
      return { ok: true };
    }));

    // ---------- نقل البيانات من النسخة التجريبية ----------
    // يقرأ ملف التصدير ويعرض ما فيه؛ الأقسام التجريبية مستبعدة دائمًا، ولا تُنقل الجلسات ولا كلمات المرور
    function readExport(data) {
      let src = data;
      if (typeof src === 'string') { try { src = JSON.parse(src); } catch (e) { fail('الملف ليس نسخة تصدير صالحة.'); } }
      if (!src || src.kind !== 'ihtiyat-export' || !src.db || typeof src.db !== 'object') fail('الملف ليس نسخة تصدير من نظام الاحتياط.');
      const x = migrate(structuredClone(src.db));
      if (!Array.isArray(x.departments)) fail('ملف التصدير لا يحتوي أقسامًا.');
      return { meta: src, db: x };
    }
    function exportSummary(x) {
      return x.departments.map(dep => ({
        id: dep.id, name: dep.name, demo: !!dep.demo,
        exists: db.departments.some(y => y.id === dep.id),
        teachers: x.teachers.filter(t => t.deptId === dep.id).length,
        days: x.days.filter(r => r.deptId === dep.id).length,
        accounts: x.accounts.filter(a => a.deptId === dep.id).length,
        scheduleVersion: dep.scheduleApproved ? dep.scheduleApproved.version : null,
        firstDate: x.days.filter(r => r.deptId === dep.id).map(r => r.date).sort()[0] || null,
        lastDate: x.days.filter(r => r.deptId === dep.id).map(r => r.date).sort().slice(-1)[0] || null
      }));
    }
    op('migration.preview', ['admin'], async (ctx, a) => {
      const { meta, db: x } = readExport(a.data);
      return { exportedAt: meta.exportedAt || null, schema: x.schema, departments: exportSummary(x) };
    });
    op('migration.import', ['admin'], async (ctx, a) => {
      const { meta, db: x } = readExport(a.data);
      const want = new Set(Array.isArray(a.deptIds) ? a.deptIds : []);
      const pick = x.departments.filter(dep => want.has(dep.id));
      if (!pick.length) fail('اختر قسمًا واحدًا على الأقل لنقله.');
      if (pick.some(dep => dep.demo || dep.name.includes('تجريبي'))) fail('لا يُنقل قسم تجريبي على أنه بيانات فعلية.');
      for (const dep of pick) if (db.departments.some(y => y.id === dep.id || y.name === dep.name)) fail(`القسم «${dep.name}» موجود مسبقًا في قاعدة البيانات، فلم يُنقل شيء حتى لا تتكرر البيانات.`);
      const ids = new Set(pick.map(dep => dep.id));
      const civils = new Set([db.admin && db.admin.civilId].concat(db.accounts.map(y => y.civilId)));
      const skipped = [];
      return tx(d => {
        let counts = { departments: 0, teachers: 0, days: 0, accounts: 0, audit: 0 };
        for (const dep of pick) { d.departments.push(structuredClone(dep)); counts.departments++; }
        for (const t of x.teachers) if (ids.has(t.deptId) && !t.demo) { if (d.teachers.some(y => y.id === t.id)) fail('تعارض في معرّفات المعلمين؛ لم يُنقل شيء.'); d.teachers.push(structuredClone(t)); counts.teachers++; }
        for (const r of x.days) if (ids.has(r.deptId) && !r.demo) { d.days.push(structuredClone(r)); counts.days++; }
        for (const acc of x.accounts) {
          if (!ids.has(acc.deptId)) continue;
          if (civils.has(acc.civilId)) { skipped.push(acc.name); continue; }
          civils.add(acc.civilId);
          // كلمات المرور لا تُنقل: كل حساب منقول يحتاج رمز تفعيل جديدًا يصدره المدير
          d.accounts.push({ ...structuredClone(acc), pw: null, code: null, status: acc.status === 'disabled' ? 'disabled' : 'pending', activatedAt: null, importedAt: iso() });
          counts.accounts++;
        }
        for (const e of x.audit || []) if (e.deptId && ids.has(e.deptId)) { d.audit.push({ ...structuredClone(e), imported: true }); counts.audit++; }
        audit(d, ctx, 'نقل بيانات من النسخة التجريبية', `${pick.map(p => p.name).join('، ')} — ${counts.teachers} معلم، ${counts.days} يوم، ${counts.accounts} حساب`, null, { exportedAt: meta.exportedAt || null });
        return { ok: true, counts, skippedAccounts: skipped };
      });
    });
    op('migration.export', ['admin'], async () => {
      const x = structuredClone(db);
      x.sessions = []; x.throttle = {};
      if (x.admin) x.admin = { ...x.admin, pw: null };
      for (const acc of x.accounts) { acc.pw = null; acc.code = null; }
      return { kind: 'ihtiyat-export', exportedAt: iso(), production, db: x };
    });

    // ---------- الحد من المحاولات المتكررة ----------
    // لكل رقم مدني (ببصمته) ولكل عنوان شبكة. الرسالة واحدة سواء وُجد الحساب أم لا
    const THROTTLED = new Set(['auth.login', 'auth.verifyCode', 'auth.activate', 'auth.setupAdmin', 'auth.recoverAdmin']);
    const LIMITS = { c: { max: 5, windowMin: 15, lockMin: 15 }, i: { max: 30, windowMin: 15, lockMin: 15 } };
    async function throttleKeys(args, meta) {
      const keys = [];
      const civ = String((args && args.civilId) || '').replace(/[٠-٩]/g, x => '٠١٢٣٤٥٦٧٨٩'.indexOf(x)).replace(/\D/g, '');
      keys.push('c:' + (await sha256('civil:' + civ)).slice(0, 32));
      if (meta && meta.ip) keys.push('i:' + (await sha256('ip:' + meta.ip)).slice(0, 32));
      return keys;
    }
    function lockedNow(keys) {
      const t = now().getTime();
      return keys.some(k => { const e = (db.throttle || {})[k]; return e && e.until && new Date(e.until).getTime() > t; });
    }
    function recordFailure(keys) {
      const t = now();
      const d = structuredClone(db);
      if (!d.throttle) d.throttle = {};
      for (const [k, e] of Object.entries(d.throttle)) if (t - new Date(e.first) > 24 * 3600e3 && (!e.until || new Date(e.until) < t)) delete d.throttle[k];
      for (const k of keys) {
        const L = LIMITS[k[0]];
        let e = d.throttle[k];
        if (!e || t - new Date(e.first) > L.windowMin * 60e3) e = { n: 0, first: t.toISOString(), until: null };
        e.n++;
        if (e.n >= L.max) e.until = new Date(t.getTime() + L.lockMin * 60e3).toISOString();
        d.throttle[k] = e;
      }
      commit(d);
    }
    function clearFailures(keys) {
      if (!keys.some(k => k[0] === 'c' && db.throttle && db.throttle[k])) return;
      const d = structuredClone(db);
      for (const k of keys) if (k[0] === 'c') delete d.throttle[k];
      commit(d);
    }

    /* صلاحيات مدير المدرسة ومساعده: كل عمليات القسم المتاحة لرئيس القسم، وإدارة الأقسام والمعلمين والجداول والحالة الافتتاحية،
       داخل أقسام مدرستهما فقط (يتحقق scope من انتماء القسم). الحسابات والنواب والنظام تبقى لمدير النظام. */
    // ================= جدول المدرسة =================
    const TT = TTOps.install({
      op, tx, fail, audit, iso, uid, cleanName, deptIn, schoolIn, deptsOfSchool, teachersOf, bump, Engine, validateSchedulePayload, newDept, kuwaitToday, now,
      db: () => db, schedAt, addScheduleVersion, scope, srcNow, ittAfterAdmin: (d, dep, v, ctx) => ittAfterAdmin(d, dep, v, ctx)
    });
    // ================= جدولي وطلبات تبديل الحصص المؤقتة =================
    const SW = SwapOps.install({ op, tx, fail, audit, iso, uid, deptIn, schoolIn, deptsOfSchool, teachersOf, Engine, kuwaitToday, now, schedAt, liveGrants, db: () => db, lessonStart: (sc, date, p) => BL.lessonStart(sc, date, p), bellDay: (sc, date, tid) => BL.dayInfo(sc, date, tid) });
    // ================= توقيت اليوم الدراسي والمراقبات والالتزامات =================
    const BL = BellOps.install({ op, tx, fail, audit, iso, uid, deptIn, schoolIn, deptsOfSchool, teachersOf, Engine, kuwaitToday, now, schedAt, liveGrants, db: () => db, sw: () => SW, adminTeacher: d => adminTeacherOf(d) });
    // ================= الإشعارات: الإعدادات والأحداث والتذكيرات =================
    const NT = Notify ? Notify.install({ op, tx, fail, audit, iso, deptIn, schoolIn, deptsOfSchool, Engine, kuwaitToday, now, liveGrants, db: () => db, sw: () => SW, bl: () => BL, att: () => attApi }) : null;

    // ================= بلاغ الحضور لليوم الدراسي القادم =================
    /* كل حساب مرتبط بسجل معلم يبلّغ حالته لنفسه فقط: حاضر / استئذان صباحي / غائب. البلاغ مبدئي ومنفصل عن الغياب المعتمد:
       لا دين ولا احتياط ولا دور بمجرده. الوقت من الخادم بتوقيت الكويت: يُفتح الساعة 3:00 عصرًا لليوم الدراسي القادم،
       ويُغلق الساعة 2:00 ظهر اليوم المستهدف. سطر واحد لكل (معلم، تاريخ)، وكل تعديل يُحفظ في سجله مع وقته وصاحبه. */
    const ATT = { open: '15:00', close: '14:00', summary: '07:42', auto: '08:00' };
    const ATT_ST = { present: 'حاضر', late: 'استئذان صباحي', absent: 'غائب' };
    const kwHM = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuwait', hour: '2-digit', minute: '2-digit', hour12: false }).format(now()).replace(/^24:/, '00:');
    const addDaysS = (ds, n) => { const x = new Date(ds + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
    const attHM = v => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : null);
    // يوم دراسي للمعلم: توقيت المدرسة لا يجعله عطلة، وجدول القسم الساري يتضمنه
    function attStudy(d, sc, dep, date) {
      const b = sc ? BL.bellFor(sc, date) : { state: 'unset' };
      if (b.state === 'off') return false;
      const sch = SW.effAt(d, dep, date);
      if (sch) return sch.days.includes(Engine.dayKeyOf(date));
      return b.state === 'ok';
    }
    // نافذة التسجيل الحالية لقسم: { open, date, closesAt } — date هو اليوم الدراسي المستهدف (أو null)
    function attWindow(d, dep) {
      const sc = dep && dep.schoolId ? schoolIn(d, dep.schoolId) : null;
      const today = kuwaitToday(now()), hm = kwHM();
      const study = x => attStudy(d, sc, dep, x);
      const next = from => { for (let i = 1; i <= 40; i++) { const x = addDaysS(from, i); if (study(x)) return x; } return null; };
      if (study(today) && hm < ATT.close) return { open: true, date: today, today, hm };
      if (study(today) && hm < ATT.open) return { open: false, date: null, today, hm, reopens: ATT.open };
      const nd = next(today);
      return { open: !!nd, date: nd, today, hm };
    }
    const attOf = (d, tid, date) => (d.attReports || []).find(x => x.teacherId === tid && x.date === date) || null;
    /* حد الاستئذان الشهري: 4 استئذانات لكل معلم في الشهر الميلادي (ثابت). وحد اختياري للمدرسة: مجموع مدتها 12 ساعة في الشهر
       (مطفأ افتراضيًا؛ يشغّله مدير النظام أو مدير المدرسة). المدة: من بداية اليوم الدراسي (أول فترة في التوقيت) حتى وقت الوصول،
       أو مجموع مدد الحصص المختارة. الحد على تسجيل المعلم لنفسه فقط؛ رئيس القسم ونوابه ومدير النظام يسجلون فوقه للضرورة. */
    const LATE_MAX = 4, LATE_MIN = 12 * 60;
    const hmMin = hm => Number(String(hm).slice(0, 2)) * 60 + Number(String(hm).slice(3, 5));
    const lateHoursOn = sc => !!(sc && sc.lateHours && sc.lateHours.on);
    function lateMinutes(d, dep, x, date) {
      const sc = dep && dep.schoolId ? schoolIn(d, dep.schoolId) : null;
      const b = sc ? BL.bellFor(sc, date) : { state: 'unset' };
      if (b.state !== 'ok' || !b.periods || !b.periods.length) return null;
      if (x.arrival) return Math.max(0, hmMin(x.arrival) - hmMin(b.periods[0].start));
      return b.periods.filter(p => p.type === 'lesson' && (x.periods || []).includes(p.lessonNo)).reduce((s, p) => s + Math.max(0, hmMin(p.end) - hmMin(p.start)), 0);
    }
    function lateQuota(d, dep, tid, date) {
      const sc = dep && dep.schoolId ? schoolIn(d, dep.schoolId) : null;
      const m = String(date).slice(0, 7); let used = 0, usedMin = 0;
      for (const x of d.attReports || []) if (x.teacherId === tid && x.status === 'late' && String(x.date).slice(0, 7) === m && x.date !== date) { used++; usedMin += lateMinutes(d, dep, x, x.date) || 0; }
      const b = sc ? BL.bellFor(sc, date) : { state: 'unset' };
      return { max: LATE_MAX, used, left: Math.max(0, LATE_MAX - used), hoursOn: lateHoursOn(sc), maxMin: LATE_MIN, usedMin, leftMin: Math.max(0, LATE_MIN - usedMin),
        dayStart: b.state === 'ok' && b.periods && b.periods.length ? b.periods[0].start : null };
    }
    const fmtMin = m => { const h = Math.floor(m / 60), r = m % 60; const H = h === 1 ? 'ساعة' : h === 2 ? 'ساعتان' : h <= 10 ? `${h} ساعات` : `${h} ساعة`; return h && r ? `${H} و${r} دقيقة` : h ? H : `${r} دقيقة`; };
    // حصص التدريس الفعلية للمعلم في التاريخ (بالتبديلات المؤقتة المعتمدة)، وحصص اليوم من التوقيت
    function attDayInfo(d, dep, tid, date) {
      const sc = dep.schoolId ? schoolIn(d, dep.schoolId) : null;
      const sch = SW.effAt(d, dep, date); const dk = Engine.dayKeyOf(date);
      const teach = sch ? sch.entries.filter(e => e.teacherId === tid && e.day === dk && e.type === 'teach').map(e => ({ period: e.period, cls: e.cls == null ? '' : String(e.cls) })).sort((x, y) => x.period - y.period) : [];
      const periods = sch && sch.periodsByDay && sch.periodsByDay[dk] ? sch.periodsByDay[dk].slice() : [];
      const b = sc ? BL.bellFor(sc, date) : { state: 'unset', periods: [] };
      const lessons = b.state === 'ok' ? b.periods.filter(p => p.type === 'lesson' && p.lessonNo).map(p => ({ no: p.lessonNo, start: p.start, end: p.end })) : [];
      return { teach, periods, lessons, hasSchedule: !!sch, bellOk: b.state === 'ok' };
    }
    // الحصص المتأثرة بالاستئذان: من وقت الوصول (كل حصة تبدأ قبله) أو من الحصص المختارة، ضمن حصص تدريسه الفعلية فقط
    function attAffected(info, arrival, periods) {
      const teach = info.teach.map(x => x.period);
      if (arrival) {
        if (!info.bellOk) return { affected: [], incomplete: 'توقيت ذلك اليوم غير مضبوط للمدرسة؛ لا يمكن تحديد الحصص من وقت الوصول. اختر الحصص بدلًا من ذلك.' };
        if (!info.hasSchedule) return { affected: [], incomplete: 'لا يوجد جدول ساري لقسمك في ذلك اليوم.' };
        const missed = info.lessons.filter(l => l.start < arrival).map(l => l.no);
        const miss = info.lessons.filter(l => teach.includes(l.no)).length < teach.length ? 'بعض حصصك ليست في توقيت اليوم؛ تأكد من الحصص.' : null;
        return { affected: teach.filter(p => missed.includes(p)), incomplete: miss };
      }
      if (!info.hasSchedule) return { affected: [], incomplete: 'لا يوجد جدول ساري لقسمك في ذلك اليوم.' };
      return { affected: teach.filter(p => periods.includes(p)), incomplete: null };
    }
    function attClean(a, info) {
      const status = String(a && a.status || '');
      if (!ATT_ST[status]) fail('اختر الحالة: حاضر أو استئذان صباحي أو غائب.');
      if (status !== 'late') return { status, arrival: null, periods: [], affected: [], incomplete: null };
      const arrival = a.arrival ? attHM(a.arrival) : null;
      if (a.arrival && !arrival) fail('وقت الوصول غير صالح (مثل 08:30).');
      const valid = new Set(info.periods.length ? info.periods : info.teach.map(x => x.period));
      const periods = arrival ? [] : Array.from(new Set((Array.isArray(a.periods) ? a.periods : []).map(Number).filter(p => Number.isInteger(p) && valid.has(p)))).sort((x, y) => x - y);
      if (!arrival && !periods.length) fail('حدّد وقت وصولك المتوقع أو الحصص التي لن تحضرها.');
      const x = attAffected(info, arrival, periods);
      return { status, arrival, periods, affected: x.affected, incomplete: x.incomplete };
    }
    // صاحب البلاغ: المعلم المرتبط بالحساب (ومدير النظام المربوط بسجل معلم)
    function attMe(d, ctx) {
      const t = ctx.role === 'admin' ? adminTeacherOf(d) : (ctx.role === 'teacher' || ctx.role === 'head') ? SW.linkedOf(d, ctx) : null;
      if (!t) return null;
      const dep = deptIn(d, t.deptId); if (!dep) return null;
      return { t, dep };
    }
    /* غياب تلقائي الساعة 8:00 صباح اليوم الدراسي: كل عضو فعّال في قسم مفعّل له «تسجيل حالة الحضور» ولم يسجل حالته
       يُسجَّل «غائب» باسم النظام — عدا رئيس القسم (يبقى «لم يسجل»). سطر جديد فقط؛ لا يُغيَّر بلاغ موجود.
       يبقى للمعلم تعديل حالته حتى إغلاق التسجيل (2:00 ظهرًا) ويصل التعديل لرئيس القسم كالمعتاد. */
    const kwAtMs = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+03:00`);
    function attHeadTids(d, dep) {
      const out = new Set(); if (dep.headTeacherId) out.add(dep.headTeacherId);
      for (const a of d.accounts) if (a.deptId === dep.id && a.status === 'active' && (a.kind === 'head' || !a.kind)) { const t = SW.linkedTeacherOfAcc(d, a); if (t) out.add(t.id); }
      return out;
    }
    async function attAutoRun(fromMs, toMs) {
      const date = kuwaitToday(new Date(toMs)); const S = kwAtMs(date, ATT.auto);
      if (!(S > fromMs && S <= toMs)) return { count: 0, date };
      sync();
      const due = d => d.departments.filter(dep => dep.status !== 'inactive' && attEnabled(dep) && !(dep.attOn.at && Date.parse(dep.attOn.at) > S)).map(dep => {
        const sc = dep.schoolId ? schoolIn(d, dep.schoolId) : null;
        if (!sc || sc.status !== 'active' || !attStudy(d, sc, dep, date)) return null;
        const heads = attHeadTids(d, dep);
        const ts = d.teachers.filter(t => t.deptId === dep.id && t.status === 'active' && !heads.has(t.id) && !attOf(d, t.id, date));
        return ts.length ? { dep, ts } : null;
      }).filter(Boolean);
      if (!due(db).length) return { count: 0, date };
      return tx(d => {
        let count = 0; const at = iso();
        for (const { dep, ts } of due(d)) {
          for (const t of ts) {
            const v = { status: 'absent', arrival: null, periods: [], affected: [] };
            d.attReports.push({ id: uid('att'), schoolId: dep.schoolId || null, deptId: dep.id, teacherId: t.id, date, createdAt: at, ...v, incomplete: null, by: 'system', byName: 'النظام', at, auto: true,
              history: [{ at, by: 'system', byName: 'النظام', ...v, auto: true }] });
            count++;
          }
          audit(d, null, 'غياب تلقائي', `لم يسجلوا حالة الحضور حتى الساعة 8:00 فسُجّلوا «غائب»: ${ts.map(t => t.name).join('، ')}`, dep.id);
        }
        return { count, date };
      });
    }
    // الخاصية كلها لكل قسم: مطفأة افتراضيًا، ويشغّلها رئيس القسم (أو الإدارة) من «إعدادات الاحتياط»
    const attEnabled = dep => !!(dep && dep.attOn && dep.attOn.on);
    const ATT_ROLE = { self: 'المعلم', head: 'رئيس القسم', deputy: 'نائب رئيس القسم', admin: 'مدير النظام', system: 'النظام' };
    const attRoleOf = x => (x ? x.byRole || (x.auto || x.by === 'system' ? 'system' : 'self') : null);
    const attView = x => (x ? { status: x.status, statusName: ATT_ST[x.status], auto: !!x.auto, arrival: x.arrival || null, periods: (x.periods || []).slice(), affected: (x.affected || []).slice(), incomplete: x.incomplete || null, at: x.at, byName: x.byName || '', byRole: attRoleOf(x), byRoleName: ATT_ROLE[attRoleOf(x)] || '' } : null);
    // من يعدّل حالة غيره: رئيس القسم ونوابه لقسمهم الأصلي فقط (لا بتفويض)، ومدير النظام
    const attCanEditOthers = (ctx, dep) => !!dep && (ctx.role === 'admin' || (ctx.role === 'head' && (ctx.kind === 'head' || ctx.kind === 'deputy') && ctx.deptId === dep.id && !ctx.viaGrant));
    // الحفظ الموحد (المعلم لنفسه، أو المسؤول لغيره): منع الكتابة فوق تعديل أحدث، وسجل كامل لكل تعديل
    function attWrite(d, ctx, dep, tid, w, a, role) {
      const v = attClean(a, attDayInfo(d, dep, tid, w.date));
      let x = attOf(d, tid, w.date);
      if (a.base !== undefined && (x ? x.at : null) !== (a.base || null)) fail('عُدّلت هذه الحالة من شخص آخر بعد فتحك لها. أُعيد تحميل الحالة الحالية؛ راجعها ثم أعد المحاولة.', 'stale');
      const same = x && x.status === v.status && (x.arrival || null) === v.arrival && JSON.stringify(x.periods || []) === JSON.stringify(v.periods) && JSON.stringify(x.affected || []) === JSON.stringify(v.affected);
      if (same) return { x, v, unchanged: true };
      if (v.status === 'late' && role === 'self') {
        const q = lateQuota(d, dep, tid, w.date);
        if (q.left <= 0) fail(`استنفدت ${LATE_MAX} استئذانات لهذا الشهر. يمكنك تسجيل «حاضر» أو «غائب»، أو مراجعة رئيس القسم.`, 'late_limit');
        if (q.hoursOn) { const mins = lateMinutes(d, dep, v, w.date); if (mins != null && mins > q.leftMin) fail(`مدة هذا الاستئذان ${fmtMin(mins)}، والباقي لك هذا الشهر ${fmtMin(q.leftMin)} من 12 ساعة.`, 'late_limit'); }
      }
      const by = ctx.role === 'admin' ? 'admin' : ctx.id, byName = ctx.role === 'admin' ? (d.admin && d.admin.name) || 'مدير النظام' : ctx.name;
      const at = iso();
      const prev = x ? { status: x.status, arrival: x.arrival || null, periods: (x.periods || []).slice(), affected: (x.affected || []).slice() } : null;
      const entry = { at, by, byName, byRole: role, status: v.status, arrival: v.arrival, periods: v.periods, affected: v.affected, prev };
      if (!x) { x = { id: uid('att'), schoolId: dep.schoolId || null, deptId: dep.id, teacherId: tid, date: w.date, createdAt: at, history: [] }; d.attReports.push(x); }
      Object.assign(x, { status: v.status, arrival: v.arrival, periods: v.periods, affected: v.affected, incomplete: v.incomplete, by, byName, byRole: role, at });
      delete x.auto; // أي تعديل بشري يلغي صفة «تلقائي»
      x.history = (x.history || []).concat([entry]).slice(-30);
      return { x, v, prev, unchanged: false };
    }
    // بطاقة «دوري»: دين المعلم أو حصصه الزيادة، وكم دورًا قبله (له وحده؛ لا أسماء ولا بيانات غيره)
    op('my.turn', ['admin', 'head', 'teacher'], async (ctx, a) => {
      const m = attMe(db, ctx); if (!m) return { linked: false };
      const { t, dep } = m; const st = dep.state || {}; const set = settingsOf(dep);
      const ts = teachersOf(db, dep.id);
      const ring = Engine.buildRing(ts, dep.headTeacherId);
      const tr = Engine.turnsAhead(ring, new Map(ts.map(x => [x.id, x])), st, t.id);
      const debt = Math.max(0, (st.debts && st.debts[t.id]) || 0);
      const credit = Math.max(0, (st.extraCredits && st.extraCredits[t.id]) || 0);
      return { linked: true, confirmed: !!st.confirmed, debtOn: set.debt, rotOn: set.rotation, debt, credit,
        isHead: dep.headTeacherId === t.id, inRing: tr.inRing, ahead: tr.ahead == null ? null : tr.ahead, ringSize: tr.ringSize,
        pending: (st.pending || []).some(p => p.teacherId === t.id) };
    });
    /* بيانات بطاقات الواجهة الرئيسية المختارة (قراءة فقط): كل بطاقة حسب دور الحساب ونطاقه — المعلم لنفسه فقط،
       رئيس القسم ونوابه لقسمهم، والإدارة ومدير النظام لأقسام المدرسة (يختار القسم المعروض). */
    const HOME_ROLES = { now: 'admin school head teacher', myatt: 'admin head teacher', myres: 'admin head teacher', turn: 'admin head teacher', myday: 'admin head teacher',
      deptatt: 'admin school head', schoolatt: 'admin school', dist: 'admin school head', deptday: 'admin school head', debt: 'admin school head' };
    op('home.data', ['admin', 'head', 'teacher'], async (ctx, a) => {
      a = a || {};
      const today = kuwaitToday(now()), dk = Engine.dayKeyOf(today);
      const ok = k => (HOME_ROLES[k] || '').split(' ').includes(ctx.role);
      const want = new Set((Array.isArray(a.want) ? a.want : []).map(String).filter(ok));
      const me = attMe(db, ctx);
      let choices;
      if (ctx.role === 'admin') { const sid = me && me.dep.schoolId; choices = sid ? deptsOfSchool(db, sid) : db.departments.slice(); }
      else if (ctx.role === 'school') choices = deptsOfSchool(db, ctx.schoolId);
      else { const own = deptIn(db, ctx.deptId); choices = own ? [own] : []; }
      choices = choices.filter(x => x.status !== 'inactive');
      const pick = ctx.role === 'admin' || ctx.role === 'school';
      const dep = pick ? (choices.find(x => x.id === a.deptId) || (me && choices.find(x => x.id === me.dep.id)) || choices[0] || null) : (ctx.role === 'head' ? choices[0] || null : null);
      const out = { today, dayName: Engine.DAY_NAMES[dk], depts: pick ? choices.map(x => ({ id: x.id, name: x.name })) : [], deptId: dep ? dep.id : null, deptName: dep ? dep.name : null };
      const tName = id => (db.teachers.find(t => t.id === id) || {}).name || '—';
      const actOf = d0 => teachersOf(db, d0.id).filter(t => t.status === 'active').sort((x, y) => (x.rotationOrder ?? 1e9) - (y.rotationOrder ?? 1e9) || x.name.localeCompare(y.name, 'ar'));
      const stOf = (t, d0) => { const x = attEnabled(d0) ? attOf(db, t.id, today) : null; return x ? { st: x.status, arrival: x.arrival || null, affected: (x.affected || []).slice() } : { st: 'none', arrival: null, affected: [] }; };
      const typeName = e => (e.type === 'teach' ? (e.cls == null ? '' : String(e.cls)) : (Engine.SLOT_TYPES[e.type] || 'التزام'));
      if (want.has('deptatt') && dep) {
        out.deptatt = attEnabled(dep) ? { enabled: true, rows: actOf(dep).map(t => ({ name: t.name, ...stOf(t, dep) })) } : { enabled: false, rows: [] };
      }
      if (want.has('schoolatt')) {
        const sid = ctx.role === 'school' ? ctx.schoolId : (dep && dep.schoolId) || (me && me.dep.schoolId) || null;
        out.schoolatt = { rows: (sid ? deptsOfSchool(db, sid) : []).filter(x => x.status !== 'inactive').map(d0 => {
          if (!attEnabled(d0)) return { deptName: d0.name, enabled: false };
          const c = { present: 0, late: 0, absent: 0, none: 0 }; for (const t of actOf(d0)) c[stOf(t, d0).st] = (c[stOf(t, d0).st] || 0) + 1;
          return { deptName: d0.name, enabled: true, ...c };
        }) };
      }
      if (want.has('dist') && dep) {
        const rec = db.days.find(x => x.deptId === dep.id && x.date === today) || null;
        const set = settingsOf(dep), st = dep.state || {};
        let next = null;
        if (set.rotation && st.confirmed) {
          const ts = teachersOf(db, dep.id); const ring = Engine.buildRing(ts, dep.headTeacherId);
          const nx = Engine.nextPriority(ring, new Map(ts.map(x => [x.id, x])), st.pointer, st.pending, st.skips, st.manualNext, st.earlyTurns, st.extraCredits);
          next = nx.id ? tName(nx.id) : null;
        }
        out.dist = { approved: !!rec, noAbsence: !!(rec && rec.noAbsence), next, rotOn: set.rotation,
          slots: rec ? (rec.result.slots || []).map(x => ({ period: x.period, cls: x.cls, absentName: x.absentName || '', teacherName: x.teacherName || null, status: x.status, source: x.source || null, kind: x.kind || null })) : [] };
      }
      if (want.has('deptday') && dep) {
        const sch = SW.effAt(db, dep, today);
        const ents = sch ? sch.entries.filter(e => e.day === dk) : [];
        const ps = Array.from(new Set(ents.map(e => e.period))).sort((x, y) => x - y);
        const P = ps.length ? Math.max(7, ps[ps.length - 1]) : 7;
        const rows = actOf(dep).map(t => {
          const cells = {}; for (const e of ents) if (e.teacherId === t.id) cells[e.period] = { txt: typeName(e), teach: e.type === 'teach' };
          return Object.keys(cells).length ? { name: t.name, cells, ...stOf(t, dep) } : null;
        }).filter(Boolean);
        out.deptday = { hasSchedule: !!sch, attOn: attEnabled(dep), periods: Array.from({ length: P }, (_, i) => i + 1), rows };
      }
      if (want.has('debt') && dep) {
        const st = dep.state || {}, set = settingsOf(dep);
        out.debt = { on: set.debt || set.rotation, rows: actOf(dep).map(t => {
          const debt = Math.max(0, (st.debts && st.debts[t.id]) || 0), cr = Math.max(0, (st.extraCredits && st.extraCredits[t.id]) || 0);
          return debt || cr ? { name: t.name, v: debt ? -debt : cr } : null;
        }).filter(Boolean).sort((x, y) => x.v - y.v) };
      }
      if ((want.has('myday') || want.has('myres')) && me) {
        const sch = SW.effAt(db, me.dep, today);
        const mine = sch ? sch.entries.filter(e => e.day === dk && e.teacherId === me.t.id).map(e => ({ period: e.period, txt: typeName(e), teach: e.type === 'teach' })) : [];
        const rec = db.days.find(x => x.deptId === me.dep.id && x.date === today) || null;
        const res = rec ? (rec.result.slots || []).filter(x => x.status === 'covered' && x.teacherId === me.t.id).map(x => ({ period: x.period, cls: x.cls, absentName: x.absentName || '' })) : [];
        for (const e of aaIncoming(db, me.dep.id, today)) if (e.teacherId === me.t.id) res.push({ period: e.period, cls: e.cls, absentName: e.absentName || '', admin: true });
        res.sort((x, y) => x.period - y.period);
        out.my = { linked: true, hasSchedule: !!sch, items: mine.sort((x, y) => x.period - y.period), reserve: res, approved: !!rec };
      } else if (want.has('myday') || want.has('myres')) out.my = { linked: false };
      return out;
    });
    op('att.mine', ['admin', 'head', 'teacher'], async (ctx, a) => {
      const m = attMe(db, ctx); if (!m) return { linked: false };
      if (!attEnabled(m.dep)) return { linked: true, enabled: false };
      const w = attWindow(db, m.dep);
      const rep = w.date ? attOf(db, m.t.id, w.date) : null;
      // من رابط تذكير: حالة التاريخ المقصود (مفتوح للتعديل أو مغلق مع الحالة المحفوظة)
      const asked = isDateStr(a && a.date) && a.date !== w.date ? { date: a.date, dayName: Engine.DAY_NAMES[Engine.dayKeyOf(a.date)], open: false, report: attView(attOf(db, m.t.id, a.date)) } : null;
      return { linked: true, enabled: true, teacherName: m.t.name, asked, window: { open: w.open, date: w.date, dayName: w.date ? Engine.DAY_NAMES[Engine.dayKeyOf(w.date)] : null, closesAt: ATT.close, opensAt: ATT.open, serverTime: w.hm, today: w.today },
        report: attView(rep), day: w.date ? attDayInfo(db, m.dep, m.t.id, w.date) : null, late: w.date ? lateQuota(db, m.dep, m.t.id, w.date) : null };
    });
    op('att.preview', ['admin', 'head', 'teacher'], async (ctx, a) => {
      const m = attMe(db, ctx); if (!m) fail('حسابك غير مرتبط بسجل معلم.', 'forbidden');
      if (!attEnabled(m.dep)) fail('تسجيل حالة الحضور غير مفعّل لقسمك.', 'forbidden');
      const w = attWindow(db, m.dep); if (!w.open || a.date !== w.date) fail('التسجيل غير متاح لهذا التاريخ الآن.', 'conflict');
      return attClean(a, attDayInfo(db, m.dep, m.t.id, w.date));
    });
    op('att.set', ['admin', 'head', 'teacher'], async (ctx, a) => {
      const m0 = attMe(db, ctx); if (!m0) fail('حسابك غير مرتبط بسجل معلم.', 'forbidden');
      return tx(d => {
        const m = attMe(d, ctx); if (!m) fail('حسابك غير مرتبط بسجل معلم.', 'forbidden');
        if (!attEnabled(m.dep)) fail('تسجيل حالة الحضور غير مفعّل لقسمك.', 'forbidden');
        const w = attWindow(d, m.dep);
        if (!w.open) fail(`أُغلق التسجيل (يُغلق الساعة 2:00 ظهرًا ويُفتح لليوم الدراسي القادم الساعة 3:00 عصرًا).`, 'closed');
        if (a.date !== w.date) fail(`التسجيل الآن ليوم ${Engine.DAY_NAMES[Engine.dayKeyOf(w.date)]} ${w.date} فقط. حدّث الصفحة.`, 'conflict');
        const r = attWrite(d, ctx, m.dep, m.t.id, w, a, 'self');
        return { report: attView(r.x), unchanged: r.unchanged };
      });
    });
    /* رئيس القسم ونوابه (ومدير النظام): تعديل حالة أي معلم فعّال في القسم، ضمن فترة التسجيل نفسها فقط.
       الحالة تبقى إبلاغًا مبدئيًا: لا تغيّر الغياب المعتمد ولا الدين ولا الدور ولا التكليفات. */
    op('att.setFor', ['admin', 'head'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId));
      if (!attCanEditOthers(ctx, dep)) fail('تعديل حالة المعلمين لرئيس القسم ونوابه في قسمهم فقط.', 'forbidden');
      if (!attEnabled(dep)) fail('تسجيل حالة الحضور غير مفعّل لهذا القسم.', 'forbidden');
      const t = d.teachers.find(x => x.id === a.teacherId && x.deptId === dep.id && x.status === 'active');
      if (!t) fail('المعلم ليس من أعضاء القسم الفعّالين.', 'forbidden');
      const w = attWindow(d, dep);
      if (!w.open) fail('أُغلق التسجيل (يُغلق الساعة 2:00 ظهرًا ويُفتح لليوم الدراسي القادم الساعة 3:00 عصرًا). لا يمكن تعديل يوم مغلق.', 'closed');
      if (a.date !== w.date) fail(`التعديل الآن ليوم ${Engine.DAY_NAMES[Engine.dayKeyOf(w.date)]} ${w.date} فقط. حدّث الصفحة.`, 'conflict');
      const self = ctx.role === 'admin' ? (adminTeacherOf(d) || {}).id === t.id : (SW.linkedOf(d, ctx) || {}).id === t.id;
      const role = self ? 'self' : ctx.role === 'admin' ? 'admin' : ctx.kind === 'deputy' ? 'deputy' : 'head';
      const r = attWrite(d, ctx, dep, t.id, w, a, role);
      if (!r.unchanged && !self) {
        const desc = y => (y ? ATT_ST[y.status] + (y.status === 'late' ? (y.arrival ? ' — الوصول ' + y.arrival : '') + (y.affected && y.affected.length ? ' — الحصص ' + y.affected.join('، ') : '') : '') : 'لم يسجل');
        audit(d, ctx, 'تعديل حالة حضور', `${t.name} — ${w.date}: ${desc(r.prev)} ← ${desc(r.x)}`, dep.id);
      }
      return { report: attView(r.x), unchanged: r.unchanged };
    }));
    // حالات معلمي قسم في تاريخ (نطاق الوصول نفسه لصفحة غياب اليوم): للمسؤول فقط، ولا تُكشف لغير المخوّل
    op('att.list', ['admin', 'head'], async (ctx, a) => {
      const dep = deptIn(db, scope(ctx, a.deptId));
      if (!attEnabled(dep)) return { enabled: false, rows: [] };
      const w = attWindow(db, dep);
      const date = isDateStr(a.date) ? a.date : (w.date || kuwaitToday(now()));
      const rec = db.days.find(x => x.deptId === dep.id && x.date === date) || null;
      const canEdit = attCanEditOthers(ctx, dep) && w.open && w.date === date;
      const teachers = teachersOf(db, dep.id).filter(t => t.status === 'active');
      const rows = teachers.map(t => {
        const x = attOf(db, t.id, date); const info = attDayInfo(db, dep, t.id, date);
        return { teacherId: t.id, name: t.name, report: attView(x), teach: info.teach.map(e => e.period), afterApproval: !!(x && rec && x.at > rec.approvedAt), ...(canEdit ? { day: info } : {}) };
      });
      return { enabled: true, date, dayName: Engine.DAY_NAMES[Engine.dayKeyOf(date)], window: { open: w.open && w.date === date, closesAt: ATT.close }, approved: !!rec, canEdit, rows };
    });
    /* تذكير تسجيل حالة الحضور (إعداد مستقل لكل قسم، مطفأ افتراضيًا): مدير النظام وإدارة المدرسة ضمن مدرستها،
       ورئيس القسم الأصلي لقسمه فقط. لا يغيّر حالة القسم ولا المسودات. */
    op('dept.attRemindSave', ['admin', 'head', 'school'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId));
      if (ctx.role === 'head' && !(ctx.kind === 'head' && ctx.deptId === dep.id && !ctx.viaGrant)) fail('تذكير تسجيل حالة الحضور يعدّله رئيس القسم لقسمه أو إدارة المدرسة.', 'forbidden');
      if (typeof a.on !== 'boolean') fail('قيمة غير صالحة.');
      if (a.on && !attEnabled(dep)) fail('شغّل «تسجيل حالة الحضور» للقسم أولًا.', 'conflict');
      const before = !!(dep.attRemind && dep.attRemind.on);
      if (before === a.on) return { ok: true, changed: false, on: before };
      dep.attRemind = { on: a.on, at: iso(), by: ctx.name, since: kuwaitToday(now()), sinceHM: kwHM() };
      audit(d, ctx, 'تذكير تسجيل حالة الحضور', a.on ? 'مفعّل' : 'مطفأ', dep.id);
      return { ok: true, changed: true, on: a.on };
    }));
    // تذكير بصمة التواجد (إعداد مستقل لكل قسم، مطفأ افتراضيًا)، بنفس صلاحية تذكير التسجيل
    op('dept.attPresenceSave', ['admin', 'head', 'school'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId));
      if (ctx.role === 'head' && !(ctx.kind === 'head' && ctx.deptId === dep.id && !ctx.viaGrant)) fail('تذكير بصمة التواجد يعدّله رئيس القسم لقسمه أو إدارة المدرسة.', 'forbidden');
      if (typeof a.on !== 'boolean') fail('قيمة غير صالحة.');
      if (a.on && !attEnabled(dep)) fail('شغّل «تسجيل حالة الحضور» للقسم أولًا.', 'conflict');
      const before = !!(dep.attPresence && dep.attPresence.on);
      if (before === a.on) return { ok: true, changed: false, on: before };
      dep.attPresence = { on: a.on, at: iso(), by: ctx.name };
      audit(d, ctx, 'تذكير بصمة التواجد', a.on ? 'مفعّل' : 'مطفأ', dep.id);
      return { ok: true, changed: true, on: a.on };
    }));
    // تشغيل/إيقاف «تسجيل حالة الحضور» للقسم (الصلاحية نفسها: رئيس القسم الأصلي، والإدارة، ومدير النظام). الإيقاف لا يحذف البلاغات.
    op('dept.attSave', ['admin', 'head', 'school'], async (ctx, a) => tx(d => {
      const dep = deptIn(d, scope(ctx, a.deptId));
      if (ctx.role === 'head' && !(ctx.kind === 'head' && ctx.deptId === dep.id && !ctx.viaGrant)) fail('تسجيل حالة الحضور يشغّله رئيس القسم لقسمه أو إدارة المدرسة.', 'forbidden');
      if (typeof a.on !== 'boolean') fail('قيمة غير صالحة.');
      const before = attEnabled(dep);
      if (before === a.on) return { ok: true, changed: false, on: before };
      dep.attOn = { on: a.on, at: iso(), by: ctx.name };
      audit(d, ctx, 'تسجيل حالة الحضور', a.on ? 'مفعّل' : 'مطفأ', dep.id);
      return { ok: true, changed: true, on: a.on };
    }));
    // للإشعارات: بيانات الملخص والتغييرات (تُستدعى من وحدة الإشعارات)
    const attApi = { ATT, ATT_ST, attStudy, attOf, attWindow, attEnabled };

    // ================= حسابات المعلمين =================
    /* المنظّم وحده ينشئ الحسابات: ملف بأسماء المعلمين والرقم المدني والنقال، يُطابق بسجلات المعلمين في المدرسة بعد معاينة.
       لكل معلم حساب «معلم» برمز تفعيل لمرة واحدة؛ يختار المعلم كلمة مروره بنفسه (الرقم المدني ليس كلمة مرور).
       المعلم يرى جدوله الساري وتكليفاته فقط. الرقم المدني لا يظهر كاملًا في أي عرض أو تقرير. */
    op('teacherAccounts.context', ['admin'], async (ctx, a) => {
      const sc = schoolIn(db, a.schoolId); if (!sc) fail('المدرسة غير موجودة.', 'not_found');
      const out = [];
      for (const dep of deptsOfSchool(db, sc.id)) for (const t of teachersOf(db, dep.id).filter(x => x.status === 'active')) {
        // حساب المعلم، وإلا حساب النائب/رئيس القسم المربوط بسجله (حتى يظهر ويُصدر له رمز من القائمة نفسها)
        const acc = db.accounts.find(x => x.kind === 'teacher' && x.teacherId === t.id) || db.accounts.find(x => x.teacherId === t.id && (x.kind === 'deputy' || x.kind === 'head'));
        out.push({ id: t.id, name: t.name, deptId: dep.id, deptName: dep.name, whatsapp: t.whatsapp || null, head: dep.headTeacherId === t.id, deputy: (dep.deputyTeacherIds || []).includes(t.id), sysAdmin: !!(db.admin && db.admin.teacherId === t.id),
          account: acc ? { id: acc.id, kind: acc.kind, status: acc.status, civilMasked: maskCivil(acc.civilId), pending: !!acc.code, codeExpiresAt: acc.code ? acc.code.expiresAt : null, activatedAt: acc.activatedAt || null } : null });
      }
      return { school: { id: sc.id, name: sc.name }, teachers: out };
    });
    op('teacherAccounts.import', ['admin'], async (ctx, a) => {
      const sc = schoolIn(db, a.schoolId); if (!sc) fail('المدرسة غير موجودة.', 'not_found');
      const rows = Array.isArray(a.rows) ? a.rows : [];
      if (!rows.length) fail('لا توجد صفوف للاعتماد.');
      if (rows.length > 600) fail('عدد الصفوف أكبر من المسموح.');
      const inSchool = new Set(deptsOfSchool(db, sc.id).map(x => x.id));
      const seenT = new Set(), seenC = new Set(), plan = [], skipped = [];
      for (const r of rows) {
        const t = db.teachers.find(x => x.id === r.teacherId);
        if (!t || !inSchool.has(t.deptId) || t.status !== 'active') { skipped.push({ name: String(r.name || '').slice(0, 80), reason: 'لا يوجد سجل معلم فعّال بهذا الربط في المدرسة.' }); continue; }
        let civil; try { civil = cleanCivil(r.civilId); } catch (e) { skipped.push({ name: t.name, reason: 'الرقم المدني غير صالح (12 رقمًا).' }); continue; }
        let wa = null; if (r.mobile != null && String(r.mobile).trim() !== '') { try { let m = String(r.mobile).replace(/[٠-٩]/g, x => '٠١٢٣٤٥٦٧٨٩'.indexOf(x)).replace(/\D/g, ''); if (m.length > 8) m = m.replace(/^(00)?965/, ''); wa = cleanWa(m); } catch (e) { skipped.push({ name: t.name, reason: 'رقم النقال غير صالح (8 أرقام).' }); continue; } }
        if (seenT.has(t.id)) { skipped.push({ name: t.name, reason: 'المعلم مكرر في الملف.' }); continue; }
        if (seenC.has(civil)) { skipped.push({ name: t.name, reason: 'الرقم المدني مكرر في الملف.' }); continue; }
        seenT.add(t.id); seenC.add(civil);
        const mine = db.accounts.find(x => x.kind === 'teacher' && x.teacherId === t.id);
        const other = (db.admin && db.admin.civilId === civil) ? { kind: 'admin' } : db.accounts.find(x => x.civilId === civil && x !== mine);
        if (other) { skipped.push({ name: t.name, reason: other.kind === 'teacher' ? 'الرقم المدني مسجّل لحساب معلم آخر.' : `الرقم المدني مستخدم في حساب قائم (${other.kind === 'admin' ? 'مدير النظام' : KIND_NAMES[kindOf(other)]}) — يدخل به ويرى ما تسمح به صلاحيته.`, phone: wa }); plan.push({ t, civil: null, wa, acc: null }); continue; }
        if (mine && mine.civilId !== civil) { skipped.push({ name: t.name, reason: 'للمعلم حساب برقم مدني مختلف؛ لم يُغيَّر. راجع الحساب يدويًا.', phone: wa }); plan.push({ t, civil: null, wa, acc: null }); continue; }
        plan.push({ t, civil, wa, acc: mine || null });
      }
      // الرموز تُولَّد قبل المعاملة (بصمتها فقط تُحفظ)، وتُعاد مرة واحدة هنا لإرسالها
      const made = [];
      for (const p of plan) {
        if (!p.civil || (p.acc && p.acc.status === 'active') || (p.acc && p.acc.status === 'disabled')) continue;
        const acc = p.acc ? { ...p.acc } : { id: uid('acc'), name: p.t.name, civilId: p.civil, deptId: p.t.deptId, teacherId: p.t.id, kind: 'teacher', status: 'pending', pw: null, code: null, createdAt: iso() };
        const code = await issueCode(acc, 'activate');
        made.push({ p, acc, code, isNew: !p.acc });
      }
      return tx(d => {
        let phones = 0; const created = [], reissued = [], existing = [];
        for (const p of plan) {
          const t = d.teachers.find(x => x.id === p.t.id);
          if (p.wa && p.wa !== (t.whatsapp || null)) { t.whatsapp = p.wa; phones++; }
          if (p.acc && p.acc.status === 'active') existing.push({ teacherId: t.id, name: t.name, status: 'active' });
          if (p.acc && p.acc.status === 'disabled') existing.push({ teacherId: t.id, name: t.name, status: 'disabled' });
        }
        for (const m of made) {
          if (m.isNew) d.accounts.push(m.acc);
          else { const x = d.accounts.find(y => y.id === m.acc.id); x.code = m.acc.code; }
          const t = d.teachers.find(x => x.id === m.p.t.id);
          (m.isNew ? created : reissued).push({ accountId: m.acc.id, teacherId: t.id, name: t.name, deptName: (deptIn(d, t.deptId) || {}).name || '', whatsapp: t.whatsapp || null, code: m.code, expiresAt: m.acc.code.expiresAt });
        }
        audit(d, ctx, 'إنشاء حسابات المعلمين من ملف', `${sc.name}: حسابات جديدة ${created.length}، رموز جديدة ${reissued.length}، أرقام نقال حُدّثت ${phones}، صفوف لم تُعتمد ${skipped.length}`, null, { schoolId: sc.id });
        return { created, reissued, existing, skipped, phones };
      });
    });
    /* ================= استيراد حسابات المعلمين من Excel =================
       للمنظّم (كل المدارس)، ومدير المدرسة ومساعديه (كل أقسام مدرستهم)، ورئيس القسم (قسمه فقط)، والمفوَّض بصلاحية
       «استيراد حسابات المعلمين» (أقسام تفويضه). نواب رئيس القسم لا يملكونها إلا بتفويض.
       الملف يُقرأ في المتصفح؛ الخادم يصنّف كل صف من البيانات المحفوظة (لا يُوثق بتصنيف المتصفح)، ولا يُحفظ شيء قبل «تأكيد الاستيراد».
       الحساب دائمًا بدور «معلم» مرتبط بسجل معلم في القسم نفسه، بانتظار التفعيل بلا كلمة مرور؛ ولا يُغيَّر أي حساب قائم. */
    const TI_MAX = 800;
    const tiDigits = v => String(v == null ? '' : v).replace(/[٠-٩]/g, x => '٠١٢٣٤٥٦٧٨٩'.indexOf(x)).replace(/[۰-۹]/g, x => '۰۱۲۳۴۵۶۷۸۹'.indexOf(x));
    const tiNorm = s => String(s == null ? '' : s).replace(/[‎‏★]/g, '').replace(/\s+/g, ' ').trim().replace(/^أ\s*\/\s*/, '').replace(/[إأآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/\s+/g, '');
    const tiTokens = s => String(s == null ? '' : s).replace(/[‎‏★]/g, '').replace(/^\s*أ\s*\/\s*/, '').replace(/[إأآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').split(/\s+/).filter(x => x.length > 1 && !['بن', 'ابن', 'عبد', 'ال'].includes(x));
    // تشابه يستدعي المراجعة (لا يكفي للربط): احتواء أحد الاسمين للآخر، أو اشتراك اسمين أو أكثر
    function tiSimilar(a, b) {
      const x = tiNorm(a), y = tiNorm(b); if (!x || !y) return false;
      if (Math.min(x.length, y.length) >= 6 && (x.includes(y) || y.includes(x))) return true;
      const ta = new Set(tiTokens(a)); let n = 0; for (const t of new Set(tiTokens(b))) if (ta.has(t)) n++;
      return n >= 2;
    }
    // أسماء الملف المختصرة (ثلاثية مثلًا) مقابل الاسم الكامل في الموقع: كل أجزاء اسم الملف موجودة في اسم سجل واحد فقط في القسم
    // = اقتراح يُعرض للمستخدم ولا يُربط إلا باختياره (توحيد علي/على، والهمزات، و«عبد الرحمن»/«عبدالرحمن»، وترتيب الأجزاء)
    const tiCanon = s => String(s == null ? '' : s).replace(/[\u200e\u200f★]/g, '').replace(/^\s*أ\s*\/\s*/, '').replace(/[إأآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/عبد\s+/g, 'عبد').split(/\s+/).filter(x => x.length > 1 && !['بن', 'ابن', 'بنت'].includes(x));
    function tiContained(fileName, recName) {
      const a = tiCanon(fileName), b = tiCanon(recName); if (a.length < 2 || a.length > b.length) return false;
      const left = b.slice(); for (const x of a) { const i = left.indexOf(x); if (i < 0) return false; left.splice(i, 1); }
      return true;
    }
    function tiCivil(raw, num) {
      const s = tiDigits(raw).replace(/[\s ‎‏'’]/g, '');
      if (!s) return { err: 'الرقم المدني فارغ.' };
      if (/e/i.test(s) || /[.,٫]/.test(s)) return { err: 'الرقم المدني فقد دقته في Excel (صيغة علمية أو كسر). نسّق العمود «نصًا» وأعد كتابة الرقم؛ لا يُخمَّن الرقم.' };
      if (/\D/.test(s)) return { err: 'الرقم المدني يحتوي رموزًا غير الأرقام.' };
      if (s.length !== 12) return { err: `الرقم المدني ${s.length} ${s.length > 2 && s.length < 11 ? 'أرقام' : 'رقمًا'} والمطلوب 12. لا يُكمَل ولا يُخمَّن.${num && s.length < 12 ? ' قد يكون Excel حذف أصفارًا من بدايته لأن الخانة رقمية.' : ''}` };
      return { value: s };
    }
    function tiPhone(raw, num, strip965) {
      const s = tiDigits(raw).replace(/[\s ‎‏+\-().'’]/g, '');
      if (!s) return { value: null };
      if (/e/i.test(s) || /[.,٫]/.test(s)) return { err: 'رقم الهاتف فقد دقته في Excel (صيغة علمية أو كسر).' };
      if (/\D/.test(s)) return { err: 'رقم الهاتف يحتوي رموزًا غير الأرقام.' };
      const cc = /^(00)?965\d{8}$/.test(s);
      if (cc && strip965) return { value: s.slice(-8), stripped: true };
      if (cc) return { err: 'الرقم يبدأ برمز الدولة 965. اختر «إزالة رمز الدولة 965» عند ربط الأعمدة إن أردت حفظه.' };
      if (s.length !== 8) return { err: `رقم الهاتف ${s.length} ${s.length > 2 && s.length < 11 ? 'أرقام' : 'رقمًا'} والمطلوب 8 (رقم كويتي دون رمز الدولة).${num && s.length < 8 ? ' قد يكون Excel حذف أصفارًا من بدايته.' : ''}` };
      return { value: s };
    }
    // نطاق المستخدم: المدرسة (من الحساب أو من الصفحة للمنظّم) والأقسام المسموحة. يُحسب من البيانات المحفوظة فقط
    function tiScope(d, ctx, a) {
      let sid, ids;
      const grantOf = new Map();
      if (ctx.role === 'admin') {
        sid = typeof a.schoolId === 'string' ? a.schoolId : null;
        if (!schoolIn(d, sid)) fail('المدرسة غير موجودة.', 'not_found');
        ids = deptsOfSchool(d, sid).map(x => x.id);
      } else if (ctx.role === 'school') {
        if (a.schoolId && a.schoolId !== ctx.schoolId) fail('غير مصرح لك بالوصول إلى هذه المدرسة.', 'forbidden');
        sid = ctx.schoolId; ids = deptsOfSchool(d, sid).map(x => x.id);
      } else if (ctx.role === 'head') {
        const own = ctx.kind === 'head' ? deptIn(d, ctx.deptId) : null;
        const set = new Set(own ? [own.id] : []);
        for (const g of ctx.grants || []) if (g.perms.has('teacherImport')) for (const id of g.deptIds) { set.add(id); if (!(own && id === own.id) && !grantOf.has(id)) grantOf.set(id, g); }
        if (!set.size) fail('استيراد حسابات المعلمين ليس ضمن صلاحياتك. يمنحه مدير المدرسة بتفويض صريح.', 'forbidden');
        const home = deptIn(d, ctx.deptId);
        sid = home ? home.schoolId : null;
        if (!sid) fail('غير مصرح لك بالوصول إلى بيانات المدرسة.', 'forbidden');
        if (a.schoolId && a.schoolId !== sid) fail('غير مصرح لك بالوصول إلى هذه المدرسة.', 'forbidden');
        ids = [...set].filter(id => (deptIn(d, id) || {}).schoolId === sid);
      } else fail('هذه العملية ليست ضمن صلاحياتك.', 'forbidden');
      const sc = schoolIn(d, sid);
      ids = ids.filter(id => { const x = deptIn(d, id); return x && x.status !== 'inactive'; });
      if (!ids.length) fail('لا توجد أقسام فعّالة ضمن نطاقك لاستيراد المعلمين.', 'forbidden');
      return { sc, ids: new Set(ids), grantOf, fixed: ctx.role === 'head' && ids.length === 1 ? ids[0] : null };
    }
    const TI_LABEL = { unregistered: 'غير مسجّل — لا يُنشأ', new_acc: 'إنشاء حساب لمعلم موجود', exists: 'موجود مسبقًا', contact: 'تحديث بيانات اتصال بعد الموافقة', review: 'يحتاج مراجعة', excluded: 'مستبعد لعدم الصلاحية', invalid: 'غير صالح' };
    const TI_GENERIC = 'الرقم المدني مسجّل لحساب قائم خارج نطاق صلاحيتك أو بدور لا يغيّره الاستيراد. راجع إدارة المدرسة.';
    const tiInput = a => {
      const rows = Array.isArray(a.rows) ? a.rows : [];
      if (!rows.length) fail('لا توجد صفوف في الملف.');
      if (rows.length > TI_MAX) fail(`عدد الصفوف أكبر من المسموح (${TI_MAX}). قسّم الملف.`);
      const seen = new Set();
      return rows.map(x => {
        const r = Number.isInteger(x && x.r) && x.r > 0 && x.r < 1e6 ? x.r : null;
        if (r == null || seen.has(r)) fail('أرقام صفوف الملف غير صالحة.'); seen.add(r);
        const str = (v, n) => String(v == null ? '' : v).slice(0, n);
        return { r, name: str(x.name, 200), civil: str(x.civil, 40), civilNum: !!x.civilNum, phone: str(x.phone, 40), phoneNum: !!x.phoneNum, deptId: typeof x.deptId === 'string' ? x.deptId : null, deptRaw: str(x.deptRaw, 120), excluded: x.excluded === 'other' ? 'other' : x.excluded ? 'user' : null };
      });
    };
    /* تصنيف كل صف: الإجراء والملاحظات وخيارات الربط، من البيانات المحفوظة d. choices: { [r]: { teacherId, updatePhone } } */
    function tiClassify(d, ctx, S, rows, choices, opts) {
      choices = choices && typeof choices === 'object' ? choices : {};
      const sid = S.sc.id;
      const schoolDepts = new Set(deptsOfSchool(d, sid).map(x => x.id));
      const accByCivil = new Map(d.accounts.map(x => [x.civilId, x]));
      const adminCivil = d.admin ? d.admin.civilId : null;
      const civ = rows.map(x => tiCivil(x.civil, x.civilNum));
      const civRows = new Map(); civ.forEach((c, i) => { if (c.value) { if (!civRows.has(c.value)) civRows.set(c.value, []); civRows.get(c.value).push(rows[i].r); } });
      const tAcc = new Map(); for (const x of d.accounts) if (x.kind === 'teacher' && x.teacherId) tAcc.set(x.teacherId, x);
      const out = rows.map((x, i) => {
        const res = { r: x.r, action: 'invalid', notes: [], teacher: null, options: null, phone: null, deptId: null, deptName: '' };
        const end = (action, note) => { res.action = action; if (note) res.notes.push(note); return res; };
        let name; try { name = cleanName(x.name, 'اسم المعلم'); } catch (e) { return end('invalid', e.message); }
        res.name = name;
        const c = civ[i]; if (c.err) return end('invalid', c.err);
        // القسم: من الربط في المتصفح، ويُتحقق هنا من أنه من أقسام المدرسة وضمن النطاق
        if (x.excluded === 'other') return end('excluded', 'الصف لقسم آخر خارج نطاق صلاحيتك.');
        if (x.excluded) return end('excluded', 'استبعدته عند ربط الأقسام.');
        if (!x.deptId) return end('review', x.deptRaw ? `القسم «${x.deptRaw}» غير مربوط بقسم من أقسام المدرسة. اربطه في خطوة الأقسام.` : 'القسم غير محدد.');
        if (!schoolDepts.has(x.deptId)) return end('excluded', 'القسم ليس من أقسام هذه المدرسة.');
        if (!S.ids.has(x.deptId)) return end('excluded', 'القسم خارج نطاق صلاحيتك.');
        const dep = deptIn(d, x.deptId); res.deptId = dep.id; res.deptName = dep.name;
        const dupRows = civRows.get(c.value);
        if (dupRows.length > 1) return end('review', `الرقم المدني مكرر في الملف (الصفوف ${dupRows.join('، ')}).`);
        const ph = tiPhone(x.phone, x.phoneNum, !!opts.strip965);
        if (ph.err && !opts.skipBadPhone) return end('review', ph.err);
        if (ph.err) res.notes.push('سيُستورد دون الهاتف: ' + ph.err);
        if (ph.stripped) res.notes.push('أُزيل رمز الدولة 965 من الهاتف حسب اختيارك.');
        const phone = ph.err ? null : ph.value;
        const ch = choices[x.r] && typeof choices[x.r] === 'object' ? choices[x.r] : {};
        const withPhone = (action, t) => {
          res.teacher = { id: t.id, name: t.name };
          const cur = t.whatsapp || null;
          res.phone = { value: phone, current: cur, change: null, apply: false };
          if (phone && phone !== cur) {
            res.phone.change = cur ? 'replace' : 'add';
            // لا استبدال تلقائي: الرقم المختلف عن المحفوظ يُستبدل فقط باختيار صريح؛ والإضافة لخانة فارغة مختارة افتراضيًا ويمكن إلغاؤها
            res.phone.apply = typeof ch.updatePhone === 'boolean' ? ch.updatePhone : !cur;
            if (cur) res.notes.push(`الهاتف المحفوظ ${cur} يختلف عن الملف ${phone}. ${res.phone.apply ? 'سيُستبدل باختيارك.' : 'لن يُستبدل إلا إذا اخترت ذلك.'}`);
          }
          if (action === 'exists' && res.phone.change && res.phone.apply) action = 'contact';
          if (action === 'exists' && res.phone.change) res.contactPossible = true;
          return end(action);
        };
        if (adminCivil && adminCivil === c.value) return end('review', TI_GENERIC);
        const acc = accByCivil.get(c.value);
        if (acc) {
          if (acc.kind === 'teacher') {
            const t = d.teachers.find(y => y.id === acc.teacherId);
            if (!t || !S.ids.has(t.deptId)) return end('review', TI_GENERIC);
            if (t.deptId !== dep.id) return end('review', `الرقم المدني لحساب معلم في قسم «${(deptIn(d, t.deptId) || {}).name || '—'}». الاستيراد لا ينقل المعلمين بين الأقسام.`);
            if (ch.teacherId && ch.teacherId !== t.id) return end('review', `الرقم المدني مرتبط بسجل «${t.name}» لا بالسجل الذي اخترته.`);
            if (tiNorm(t.name) !== tiNorm(name)) res.notes.push(`الاسم في السجل: «${t.name}».`);
            res.notes.push(acc.status === 'active' ? 'الحساب مفعّل؛ لا يتغير.' : acc.status === 'disabled' ? 'الحساب معطّل؛ لا يغيّره الاستيراد.' : 'الحساب قائم بانتظار التفعيل.');
            res.accountId = acc.id; res.accountStatus = acc.status;
            return withPhone('exists', t);
          }
          // حساب بدور آخر (رئيس قسم، نائب، مدير...): لا يُنشأ حساب معلم ولا تتغير صلاحياته
          const inScope = acc.deptId ? S.ids.has(acc.deptId) : (SCHOOL_KINDS.includes(acc.kind) && acc.schoolId === sid && (ctx.role === 'admin' || ctx.role === 'school'));
          if (!inScope) return end('review', TI_GENERIC);
          return end('exists', `الرقم المدني لحساب قائم بدور «${KIND_NAMES[kindOf(acc)]}». لا يُنشأ حساب معلم ولا يتغير دوره أو صلاحياته.`);
        }
        // لا حساب بهذا الرقم: يُربط بسجل معلم قائم فقط. المعلم غير المسجل في القسم لا يُنشأ له سجل ولا حساب (قرار المستخدم)
        const pool = teachersOf(d, dep.id).filter(t => t.status === 'active');
        const exact = pool.filter(t => tiNorm(t.name) === tiNorm(name));
        const opt = () => { res.options = pool.filter(t => !tAcc.has(t.id)).map(t => ({ id: t.id, name: t.name })); };
        let target = null;
        if (ch.teacherId === '__new__') target = '__new__';
        else if (ch.teacherId) {
          target = pool.find(t => t.id === ch.teacherId) || null;
          if (!target) { opt(); return end('review', 'السجل المختار ليس من معلمي القسم الفعّالين.'); }
        } else if (exact.length === 1) { target = exact[0]; res.notes.push('رُبط بسجل المعلم المطابق للاسم في القسم. غيّر الربط إن لم يكن الشخص نفسه.'); }
        else if (exact.length > 1) { opt(); return end('review', 'في القسم أكثر من معلم بالاسم نفسه. اختر السجل الصحيح.'); }
        else if (pool.some(t => tiSimilar(t.name, name) || tiContained(name, t.name))) {
          opt();
          const cont = pool.filter(t => tiContained(name, t.name));
          const free = cont.filter(t => !tAcc.has(t.id));
          if (cont.length === 1 && free.length === 1) { res.suggest = { id: free[0].id, name: free[0].name }; return end('review', `اقتراح: «${free[0].name}» — أجزاء الاسم في الملف كلها موجودة في هذا السجل فقط. يُربط إذا اخترته أنت.`); }
          return end('review', 'في القسم اسم مشابه. تشابه الأسماء لا يكفي للربط: اختر السجل الصحيح إن كان الشخص نفسه، وإلا فلن يُستورد.');
        }
        else target = '__new__';
        opt();
        if (target === '__new__') return end('unregistered', `المعلم غير مسجّل في قسم «${dep.name}»، فلا يُنشأ له سجل ولا حساب. يضيفه المسؤول أولًا في صفحة «المعلمون» ثم يُعاد الاستيراد.`);
        const other = tAcc.get(target.id);
        if (other) return end('review', `لسجل «${target.name}» حساب معلم برقم مدني مختلف؛ لا يغيّره الاستيراد.`);
        return withPhone('new_acc', target);
      });
      // داخل الملف: اسم جديد مكرر في القسم نفسه، أو أكثر من صف لسجل معلم واحد
      const key = new Map(), tgt = new Map();
      for (const x of out) {
        if ((x.action === 'new_acc' || x.action === 'exists' || x.action === 'contact') && x.teacher) tgt.set(x.teacher.id, (tgt.get(x.teacher.id) || 0) + 1);
      }
      for (const x of out) {
        if ((x.action === 'new_acc' || x.action === 'exists' || x.action === 'contact') && x.teacher && tgt.get(x.teacher.id) > 1) { x.action = 'review'; x.notes.push(`أكثر من صف في الملف مرتبط بسجل «${x.teacher.name}».`); }
      }
      for (const x of out) { x.label = TI_LABEL[x.action]; x.actionable = ['new_acc', 'contact'].includes(x.action); }
      return out;
    }
    const tiTotals = list => { const t = {}; for (const k of Object.keys(TI_LABEL)) t[k] = 0; for (const x of list) t[x.action]++; return t; };
    // حسابات «معلم» بانتظار التفعيل (لم تُفعَّل قط) ضمن النطاق: يبدأ تفعيلها المستخدم نفسه
    const tiPending = (d, S) => d.accounts.filter(x => x.kind === 'teacher' && x.status === 'pending' && !x.pw && !x.activatedAt && S.ids.has(x.deptId)).map(x => {
      const t = d.teachers.find(y => y.id === x.teacherId);
      return { accountId: x.id, name: t ? t.name : x.name, deptId: x.deptId, deptName: (deptIn(d, x.deptId) || {}).name || '', whatsapp: t && t.whatsapp || null, codeActive: !!(x.code && new Date(x.code.expiresAt) > now()), createdAt: x.createdAt };
    });

    op('taImport.context', ['admin', 'school', 'head'], async (ctx, a) => {
      const S = tiScope(db, ctx, a || {});
      const depts = deptsOfSchool(db, S.sc.id).filter(x => x.status !== 'inactive').map(x => ({ id: x.id, name: x.name, inScope: S.ids.has(x.id) }));
      const n = { teachers: 0, withAccount: 0 };
      for (const id of S.ids) for (const t of teachersOf(db, id)) if (t.status === 'active') { n.teachers++; if (db.accounts.some(x => x.kind === 'teacher' && x.teacherId === t.id)) n.withAccount++; }
      return { school: { id: S.sc.id, name: S.sc.name }, depts, fixedDeptId: S.fixed, scopeKind: ctx.role === 'head' ? (S.grantOf.size ? 'grant' : 'dept') : 'school', counts: n, pending: tiPending(db, S), max: TI_MAX };
    });
    op('taImport.preview', ['admin', 'school', 'head'], async (ctx, a) => {
      const S = tiScope(db, ctx, a);
      const rows = tiInput(a);
      const list = tiClassify(db, ctx, S, rows, a.choices, { strip965: !!a.strip965, skipBadPhone: !!a.skipBadPhone });
      return { rows: list, totals: tiTotals(list) };
    });
    op('taImport.apply', ['admin', 'school', 'head'], async (ctx, a) => {
      const rows = tiInput(a);
      const sel = new Set((Array.isArray(a.selected) ? a.selected : []).filter(Number.isInteger));
      if (!sel.size) fail('لم تحدد صفوفًا للاستيراد.');
      return tx(d => {
        const S = tiScope(d, ctx, a);
        // إعادة التصنيف على البيانات الحالية داخل المعاملة: ما تغيّر منذ المعاينة يظهر في النتيجة ولا يُكرر
        const list = tiClassify(d, ctx, S, rows, a.choices, { strip965: !!a.strip965, skipBadPhone: !!a.skipBadPhone });
        const results = []; const per = new Map();
        const bump1 = (deptId, k) => { if (!deptId) return; if (!per.has(deptId)) per.set(deptId, { created: 0, phones: 0, existing: 0, failed: 0, names: [] }); per.get(deptId)[k]++; };
        for (const x of list) {
          if (!sel.has(x.r)) continue;
          try {
            if (x.action === 'new_acc') {
              const dep = deptIn(d, x.deptId);
              const t = d.teachers.find(y => y.id === x.teacher.id);
              if (!t || t.deptId !== dep.id || t.status !== 'active') throw new ApiError('سجل المعلم لم يعد متاحًا.');
              const civil = tiCivil(rows.find(y => y.r === x.r).civil).value;
              if (d.accounts.some(y => y.civilId === civil) || (d.admin && d.admin.civilId === civil)) throw new ApiError('الرقم المدني أصبح مستخدمًا.');
              if (d.accounts.some(y => y.kind === 'teacher' && y.teacherId === t.id)) throw new ApiError('للمعلم حساب الآن.');
              // كل التحقق قبل أي تعديل: الصف يُحفظ كاملًا (المعلم والحساب والهاتف) أو لا يُحفظ منه شيء
              if (x.phone && x.phone.apply && x.phone.value) { t.whatsapp = x.phone.value; bump1(dep.id, 'phones'); }
              const acc = { id: uid('acc'), name: t.name, civilId: civil, deptId: dep.id, teacherId: t.id, kind: 'teacher', status: 'pending', pw: null, code: null, createdAt: iso() };
              d.accounts.push(acc); bump1(dep.id, 'created'); per.get(dep.id).names.push(t.name);
              results.push({ r: x.r, outcome: 'created', name: t.name, deptName: dep.name, accountId: acc.id, phoneSet: !!(x.phone && x.phone.apply && x.phone.value) });
            } else if (x.action === 'contact') {
              const t = d.teachers.find(y => y.id === x.teacher.id);
              t.whatsapp = x.phone.value; bump1(x.deptId, 'phones');
              results.push({ r: x.r, outcome: 'updated', name: t.name, deptName: x.deptName });
            } else if (x.action === 'exists') {
              bump1(x.deptId, 'existing');
              results.push({ r: x.r, outcome: 'existing', name: x.name, deptName: x.deptName, reason: x.notes.join(' ') });
            } else {
              bump1(x.deptId, 'failed');
              results.push({ r: x.r, outcome: 'failed', name: x.name || '', deptName: x.deptName, reason: `${x.label}: ${x.notes.join(' ')}` });
            }
          } catch (e) {
            if (!(e instanceof ApiError)) throw e;
            bump1(x.deptId, 'failed');
            results.push({ r: x.r, outcome: 'failed', name: x.name || '', deptName: x.deptName, reason: e.message });
          }
        }
        // السجل: لكل قسم سطر بالمنفّذ والوقت والمدرسة والقسم والأعداد (دون أرقام مدنية أو رموز)
        for (const [deptId, c] of per) {
          const g = S.grantOf.get(deptId); const prev = ctx.usedGrant; if (g) ctx.usedGrant = g;
          audit(d, ctx, 'استيراد حسابات المعلمين من Excel', `${S.sc.name} — ${(deptIn(d, deptId) || {}).name || ''}: حسابات معلمين جديدة ${c.created}، أرقام هاتف حُدّثت ${c.phones}، موجودة مسبقًا ${c.existing}، لم تُنفَّذ ${c.failed}${c.names.length ? `. الحسابات: ${c.names.slice(0, 40).join('، ')}${c.names.length > 40 ? '…' : ''}` : ''}`, deptId, { schoolId: S.sc.id });
          ctx.usedGrant = prev;
        }
        const n = k => results.filter(x => x.outcome === k).length;
        return { results, counts: { created: n('created'), updated: n('updated'), existing: n('existing'), failed: n('failed') }, pending: tiPending(d, S) };
      });
    });
    /* بدء التفعيل: رمز لمرة واحدة لحسابات «معلم» لم تُفعَّل قط ضمن النطاق (الآلية المعتمدة نفسها). لا يرسل شيئًا خارجيًا،
       ولا يعيد تعيين كلمة مرور حساب مفعّل، ولا يمس غير حسابات المعلمين. الرمز يُعاد هنا مرة واحدة ولا يُحفظ إلا بصمته. */
    op('taImport.activate', ['admin', 'school', 'head'], async (ctx, a) => {
      const ids = Array.isArray(a.accountIds) ? a.accountIds.filter(x => typeof x === 'string').slice(0, TI_MAX) : [];
      if (!ids.length) fail('اختر حسابًا واحدًا على الأقل.');
      const S0 = tiScope(db, ctx, a);
      const ok = acc => acc && acc.kind === 'teacher' && acc.status === 'pending' && !acc.pw && !acc.activatedAt && S0.ids.has(acc.deptId);
      const made = [], skipped = [];
      for (const id of ids) {
        const acc0 = db.accounts.find(x => x.id === id);
        if (!ok(acc0)) { skipped.push({ accountId: id, name: acc0 && S0.ids.has(acc0.deptId) ? acc0.name : '', reason: 'ليس حساب معلم بانتظار التفعيل ضمن نطاقك.' }); continue; }
        const tmp = { ...acc0 }; const code = await issueCode(tmp, 'activate');
        made.push({ id, code, hash: tmp.code });
      }
      return tx(d => {
        const S = tiScope(d, ctx, a); const out = []; const per = new Map();
        for (const m of made) {
          const acc = d.accounts.find(x => x.id === m.id);
          if (!(acc && acc.kind === 'teacher' && acc.status === 'pending' && !acc.pw && !acc.activatedAt && S.ids.has(acc.deptId))) { skipped.push({ accountId: m.id, name: '', reason: 'تغيّرت حالة الحساب.' }); continue; }
          acc.code = m.hash;
          const t = d.teachers.find(x => x.id === acc.teacherId);
          out.push({ accountId: acc.id, name: t ? t.name : acc.name, deptName: (deptIn(d, acc.deptId) || {}).name || '', whatsapp: t && t.whatsapp || null, code: m.code, expiresAt: acc.code.expiresAt });
          per.set(acc.deptId, (per.get(acc.deptId) || 0) + 1);
        }
        for (const [deptId, k] of per) {
          const g = S.grantOf.get(deptId); const prev = ctx.usedGrant; if (g) ctx.usedGrant = g;
          audit(d, ctx, 'بدء تفعيل حسابات معلمين', `${S.sc.name} — ${(deptIn(d, deptId) || {}).name || ''}: أُصدر رمز تفعيل لـ ${k} ${k === 1 ? 'حساب' : 'حسابات'} (الرموز لا تُسجَّل).`, deptId, { schoolId: S.sc.id });
          ctx.usedGrant = prev;
        }
        return { issued: out, skipped };
      });
    });
    // ما يراه المعلم: جدوله الساري (والإصدار المجدول القادم إن وُجد) وحصص الاحتياط المكلَّف بها في الأيام المعتمدة
    op('teacher.myView', ['teacher'], async ctx => {
      const t = db.teachers.find(x => x.id === ctx.teacherId), dep = deptIn(db, ctx.deptId);
      const today = kuwaitToday(now());
      const pick = v => v ? { version: v.version, effectiveFrom: v.effectiveFrom || null, days: v.days.slice(), periodsByDay: structuredClone(v.periodsByDay),
        entries: v.entries.filter(e => e.teacherId === t.id).map(e => ({ day: e.day, period: e.period, type: e.type, cls: e.cls || '' })) } : null;
      const cur = schedAt(dep, today);
      const nx = timelineOf(dep).filter(x => !x.cancelled && effOf(x) > today && (!cur || x.version > cur.version)).sort((p, q) => (effOf(p) < effOf(q) ? -1 : 1))[0];
      const nextV = nx ? (dep.scheduleVersions || []).find(v => v.version === nx.version) || null : null;
      const from = new Date(today + 'T12:00:00Z'); from.setUTCDate(from.getUTCDate() - 60); const fromS = from.toISOString().slice(0, 10);
      const reserve = [];
      for (const rec of db.days) {
        if (rec.deptId !== dep.id || rec.date < fromS) continue;
        for (const sl of (rec.result && rec.result.slots) || []) if (sl && sl.teacherId === t.id && sl.status === 'covered') reserve.push({ date: rec.date, day: Engine.dayKeyOf(rec.date), period: sl.period, cls: sl.cls == null ? '' : String(sl.cls) });
      }
      // تكليفات من الإدارة (حصص محالة من أقسام أخرى)
      for (const e of aaList(db)) if (e.state === 'assigned' && e.teacherId === t.id && e.date >= fromS)
        reserve.push({ date: e.date, day: Engine.dayKeyOf(e.date), period: e.period, cls: e.cls == null ? '' : String(e.cls), fromAdmin: true, srcDeptName: e.srcDeptName, sourceName: e.source === 'debt' ? 'الدين' : 'الدور' });
      reserve.sort((p, q) => (p.date < q.date ? 1 : p.date > q.date ? -1 : p.period - q.period));
      return { today, teacher: { name: t.name }, deptName: dep.name, schoolName: ctx.schoolId ? (schoolIn(db, ctx.schoolId) || {}).name || '' : '', current: pick(cur), upcoming: pick(nextV), reserve: reserve.slice(0, 120) };
    });

    // خيارات معاينة الأدوار: المدارس وأقسامها والحسابات الفعّالة التي يمكن معاينتها (دون أرقام مدنية). لمدير النظام فقط.
    op('preview.options', ['admin'], async () => {
      const today = kuwaitToday(now());
      const schools = (db.schools || []).filter(x => x.status === 'active').map(sc => ({ id: sc.id, name: sc.name,
        depts: deptsOfSchool(db, sc.id).filter(d => d.status !== 'inactive').map(d => ({ id: d.id, name: d.name })) }));
      const sids = new Set(schools.map(x => x.id));
      const accounts = [], inactive = {};
      for (const a of db.accounts) {
        const dep = a.deptId ? deptIn(db, a.deptId) : null;
        const schoolId = SCHOOL_KINDS.includes(a.kind) ? a.schoolId : dep ? dep.schoolId : null;
        if (!schoolId || !sids.has(schoolId)) continue;
        if (!accountCtx(a.id, true)) { const k = schoolId + '|' + (SCHOOL_KINDS.includes(a.kind) ? 'school' : a.deptId); inactive[k] = (inactive[k] || 0) + 1; continue; }
        const row = { id: a.id, name: a.name, kind: a.kind === 'deputy' ? 'deputy' : a.kind, schoolId, deptId: SCHOOL_KINDS.includes(a.kind) ? null : a.deptId, deptName: dep ? dep.name : '' };
        if (a.kind === 'teacher') { const t = db.teachers.find(x => x.id === a.teacherId); row.teacherName = t ? t.name : a.name; row.trainee = !!(t && t.trainee); row.pending = a.status === 'pending'; }
        if (!SCHOOL_KINDS.includes(a.kind) && a.kind !== 'teacher') {
          row.grants = (db.delegations || []).filter(g => g.granteeId === a.id && delegationState(db, g, today) === 'active').map(g => ({
            schoolId: g.schoolId, perms: g.perms.filter(k => PERM_KEYS.includes(k)).map(k => PERMS.find(x => x.key === k).label),
            scope: g.allDepts ? 'كل أقسام المدرسة' : g.deptIds.map(id => (deptIn(db, id) || {}).name).filter(Boolean).join('، '), endDate: g.endDate || null, grantorName: g.grantorName || '' }));
        }
        accounts.push(row);
      }
      return { schools, accounts, inactive };
    });

    const SCHOOL_EXTRA = ['teacher.create', 'teacher.update', 'teacher.move', 'schedule.approveImport', 'importProfile.get', 'importProfile.save', 'state.setOpening'];
    for (const [n, o] of Object.entries(ops)) if (o.roles && !o.roles.includes('school') && (o.roles.includes('head') || SCHOOL_EXTRA.includes(n))) o.roles.push('school');

    /* ---------- معاينة الموقع حسب الدور (لمدير النظام الحقيقي فقط) ----------
       الطلب يحمل meta.as = { accountId }. يتحقق الخادم أولًا أن جلسة الطلب نفسها جلسة مدير النظام (لا متغير من المتصفح)،
       ثم تُنفَّذ العملية بصلاحيات الحساب المعروض فقط على نسخة مؤقتة من البيانات تُهمل بعد الرد: لا يُحفظ شيء ولا يُرسل شيء،
       ولا تتغير هوية المدير أو بياناته. */
    const PREVIEW_BLOCK = { 'me.changePassword': 'تغيير كلمة المرور', 'account.issueCode': 'إصدار رموز التفعيل', 'account.create': 'إنشاء الحسابات ورموز التفعيل', 'teacherAccounts.import': 'إنشاء حسابات المعلمين ورموزها', 'taImport.activate': 'بدء تفعيل حسابات المعلمين ورموزها' };
    async function previewCall(tokenHash, name, args, meta) {
      const real = resolve(tokenHash);
      if (!real) throw new ApiError('انتهت الجلسة. سجّل الدخول من جديد.', 'unauthenticated');
      if (real.role !== 'admin') throw new ApiError('معاينة الأدوار متاحة لمدير النظام فقط.', 'forbidden');
      if (name.startsWith('auth.') || name.startsWith('preview.')) throw new ApiError('هذه العملية لا تُنفَّذ داخل المعاينة.', 'forbidden');
      if (PREVIEW_BLOCK[name]) throw new ApiError(`${PREVIEW_BLOCK[name]} غير متاح في وضع المعاينة.`, 'preview');
      const id = meta.as && typeof meta.as.accountId === 'string' ? meta.as.accountId : '';
      if (!accountCtx(id, true)) throw new ApiError('الحساب المختار للمعاينة غير موجود أو غير فعّال. اختر حسابًا آخر.', 'preview_target');
      // نسخة مؤقتة معزولة: الكتابة فيها لا تصل إلى مصدر الحفظ الفعلي
      const raw = JSON.stringify(db); let wrote = false;
      const box = createServer({ ...opts, latency: 0, storage: { load: () => raw, save: () => { wrote = true; } } });
      const out = await box._runAs(id, name, args, { ...meta, as: null });
      meta.previewWrote = wrote;
      return out;
    }
    async function call(token, name, args, meta) {
      if (latency) await new Promise(r => setTimeout(r, latency));
      sync();
      const o = ops[name]; if (!o) throw new ApiError('عملية غير معروفة.', 'not_found');
      // الرمز لا يُحفظ؛ تُحفظ بصمته فقط
      const tokenHash = token ? await sha256(String(token)) : null;
      if (meta && meta.as) return previewCall(tokenHash, name, args, meta);
      return run(o, name, resolve(tokenHash), tokenHash, args, meta);
    }
    // داخل النسخة المؤقتة للمعاينة فقط: سياق الحساب المعروض
    async function _runAs(accountId, name, args, meta) {
      sync();
      const o = ops[name]; if (!o) throw new ApiError('عملية غير معروفة.', 'not_found');
      const ctx = accountCtx(accountId, true); if (ctx) ctx.preview = true;
      return run(o, name, ctx, null, args, meta);
    }
    async function run(o, name, resolved, tokenHash, args, meta) {
      let ctx = null;
      if (o.roles) {
        ctx = resolved;
        if (!ctx) throw new ApiError('انتهت الجلسة. سجّل الدخول من جديد.', 'unauthenticated');
        ctx.op = name;
        if (!o.roles.includes(ctx.role)) {
          // المفوَّض: العملية مسموحة فقط إن كان لديه تفويض سارٍ بها (ثم يتحقق scope من القسم)
          if (ctx.role === 'head' && OP_PERMS[name] && grantFor(ctx, name, null)) ctx.viaGrant = true;
          else throw new ApiError(ctx.role === 'head' ? 'هذه العملية ليست ضمن صلاحياتك؛ هي من صلاحيات مدير النظام أو إدارة المدرسة أو بتفويض منها.' : 'هذه العملية من صلاحيات مدير النظام فقط.', 'forbidden');
        }
      }
      let tkeys = null;
      if (THROTTLED.has(name)) {
        tkeys = await throttleKeys(args, meta);
        if (lockedNow(tkeys)) throw new ApiError('محاولات كثيرة غير ناجحة. انتظر 15 دقيقة ثم أعد المحاولة، أو راجع مدير النظام.', 'throttled');
      }
      try {
        const out = await o.fn(ctx, args || {}, tokenHash, meta || {});
        if (tkeys && name === 'auth.login') clearFailures(tkeys);
        return out;
      }
      catch (e) {
        if (e instanceof ApiError) {
          if (tkeys && e.code === 'auth') { try { recordFailure(tkeys); } catch (e2) { } }
          throw e;
        }
        // خطأ غير متوقع: لا شيء حُفظ (المعاملة على نسخة)؛ رسالة مفهومة للمستخدم والتفاصيل للتشخيص
        const err = new ApiError('حدث خطأ غير متوقع أثناء تنفيذ العملية، ولم يُحفظ أي تغيير. أعد المحاولة، وإن تكرر فأبلغ مدير النظام.', 'internal');
        err.detail = { op: name, message: String(e && e.message || e), stack: e && e.stack ? String(e.stack).slice(0, 2000) : null };
        throw err;
      }
    }
    // تُستخدم في الخلفية الفعلية لتحديد نطاق التحميل من قاعدة البيانات قبل التنفيذ
    async function sessionOf(token) { return token ? resolve(await sha256(String(token))) : null; }
    // للخلفية الفعلية: سياق الحساب المعروض في المعاينة (لتحديد نطاق التحميل فقط؛ التحقق من المدير يتم في call)
    async function previewTargetOf(token, as) {
      const real = await sessionOf(token);
      if (!real || real.role !== 'admin' || !as || typeof as.accountId !== 'string') return null;
      return accountCtx(as.accountId, true);
    }
    /* للخلفية الفعلية بعد حفظ عملية: الإشعارات الناتجة عن الفرق بين البيانات قبلها وبعدها (لا شيء في المعاينة) */
    function notifyDerive(beforeRaw, actor) { return NT ? NT.derive(JSON.parse(beforeRaw), db, actor) : []; }
    async function notifyAttAuto(from, to) { return attAutoRun(from, to); }
    function notifyReminders(from, to) { return NT && NT.anyReminder(db) ? NT.reminders(db, from, to) : []; }
    // للاختبارات المحلية فقط (غير متاح في الإنتاج): محاكاة وصول إصدار إدارة جديد لقسم
    const _ittAdmin = production ? undefined : async (deptId, mutate) => tx(d => { const dep = deptIn(d, deptId); const cur = Math.max(0, ...(dep.scheduleVersions || []).map(v => v.version)); const base = adminLatestV(dep); const v = { ...structuredClone(base), version: cur + 1, approvedAt: iso(), effectiveFrom: kuwaitToday(now()) }; mutate(v); addScheduleVersion(dep, v); ittAfterAdmin(d, dep, v, null); bump(dep); return v.version; });
    return { call, ApiError, sessionOf, previewTargetOf, _runAs, _peek: () => db, notifyDerive, notifyReminders, notifyAttAuto, _ittAdmin };
  }

  const Server = { createServer, ApiError, kuwaitToday };
  if (typeof module !== 'undefined' && module.exports) module.exports = Server;
  root.Server = Server;
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* طبقة الحفظ في PostgreSQL (Supabase) لخادم نظام الاحتياط.
 * منطق العمليات والقواعد نفسه في server.js لم يتغير؛ هذه الطبقة تحوّل بين بيانات الخادم والجداول:
 *  - تحميل ما تحتاجه العملية فقط: البيانات الخفيفة لكل الأقسام + البيانات الثقيلة لقسم العملية.
 *  - تنفيذ العملية، ثم كتابة الفروق فقط (إضافة/تعديل/حذف) داخل معاملة واحدة مقفلة.
 *  - التحقق بعد الكتابة بإعادة قراءة كل سطر كُتب أو حُذف، والتراجع الكامل عند أي اختلاف.
 *  - رئيس القسم ونوابه لا تُكتب لهم أي سطر خارج قسمهم (حماية ثانية بعد فحص الخادم).
 */
(function (root) {
  'use strict';
  const BAD = Symbol('bad');
  const SCHEMA = 'ihtiyat';

  // ---------- أنواع الأعمدة ----------
  const isTs = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && !isNaN(Date.parse(v)) && new Date(v).toISOString() === v;
  const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
  const isInt = v => Number.isInteger(v) && Math.abs(v) < 2147483647;
  const tsOut = v => v == null ? null : (v instanceof Date ? v : new Date(v)).toISOString();
  const dateOut = v => v == null ? null : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  const simple = (check, out) => ({
    cols: c => [c],
    enc: (v, c) => (v === null ? { [c]: null } : check(v) ? { [c]: v } : BAD),
    dec: (r, c) => (r[c] == null ? null : out ? out(r[c]) : r[c])
  });
  const T = {
    text: simple(v => typeof v === 'string'),
    int: simple(isInt, Number),
    bool: simple(v => typeof v === 'boolean'),
    ts: simple(isTs, tsOut),
    date: simple(isDate, dateOut),
    json: { cols: c => [c], enc: (v, c) => ({ [c]: v }), dec: (r, c) => (r[c] === undefined ? null : r[c]) },
    oneOf: (...vals) => simple(v => vals.includes(v)),
    // مرجع لمعلم موجود (مفتاح خارجي) — غير الموجود يُحفظ كما هو في extra دون كسر العلاقة
    tref: { cols: c => [c], enc: (v, c, cx) => (v === null ? { [c]: null } : typeof v === 'string' && cx.teacherIds.has(v) ? { [c]: v } : BAD), dec: (r, c) => r[c] },
    // مرجع لمدرسة موجودة (مفتاح خارجي)
    sref: { cols: c => [c], enc: (v, c, cx) => (v === null ? { [c]: null } : typeof v === 'string' && cx.schoolIds.has(v) ? { [c]: v } : BAD), dec: (r, c) => r[c] },
    group: (fields) => ({ // كائن صغير بمفاتيح ثابتة الترتيب يتوزع على أعمدة
      cols: () => fields.map(f => f[1]),
      enc: v => {
        const out = {}; for (const f of fields) out[f[1]] = null;
        if (v === null) return out;
        if (!v || typeof v !== 'object' || Array.isArray(v)) return BAD;
        const keys = Object.keys(v);
        if (keys.length !== fields.length || keys.some((k, i) => k !== fields[i][0])) return BAD;
        for (const [k, col, typ] of fields) { const e = T[typ].enc(v[k], col); if (e === BAD || v[k] === null) return BAD; out[col] = e[col]; }
        return out;
      },
      dec: r => { if (r[fields[0][1]] == null) return null; const o = {}; for (const [k, col, typ] of fields) o[k] = T[typ].dec(r, col); return o; }
    })
  };

  /* ترميز كائن: الأعمدة المعروفة في أعمدتها، وبقية المفاتيح وترتيبها في extra.
     القيمة التي لا تطابق نوع عمودها تُحفظ كما هي في extra.o، فلا يضيع شيء. */
  function encodeObj(obj, cols, cx, opts) {
    const row = {}; const children = (opts && opts.children) || {};
    for (const key in cols) for (const c of cols[key][1].cols(cols[key][0])) row[c] = null;
    const keys = Object.keys(obj); const f = {}, o = {}; let hf = false, ho = false;
    for (const key of keys) {
      const v = obj[key];
      if (key in children) { if (!children[key]) { o[key] = v; ho = true; } continue; }
      const spec = cols[key];
      if (spec) { const e = spec[1].enc(v, spec[0], cx); if (e === BAD) { o[key] = v; ho = true; } else Object.assign(row, e); }
      else { f[key] = v; hf = true; }
    }
    row.extra = { k: keys }; if (hf) row.extra.f = f; if (ho) row.extra.o = o;
    return row;
  }
  function decodeObj(row, cols, childVals) {
    const x = typeof row.extra === 'string' ? JSON.parse(row.extra) : row.extra; const out = {};
    for (const key of x.k) {
      if (x.o && Object.prototype.hasOwnProperty.call(x.o, key)) out[key] = x.o[key];
      else if (childVals && Object.prototype.hasOwnProperty.call(childVals, key)) out[key] = childVals[key];
      else if (cols[key]) out[key] = cols[key][1].dec(row, cols[key][0]);
      else out[key] = x.f[key];
    }
    return out;
  }

  // ---------- مواصفات الجداول ----------
  const C = {
    meta: { systemName: ['system_name', T.text], createdAt: ['created_at', T.ts] },
    user: {
      id: ['id', T.text], name: ['name', T.text], civilId: ['civil_id', T.text], deptId: ['dept_id', T.text], teacherId: ['teacher_id', T.text], schoolId: ['school_id', T.sref],
      status: ['status', T.oneOf('active', 'pending', 'disabled')],
      pw: ['pw', T.group([['salt', 'pw_salt', 'text'], ['hash', 'pw_hash', 'text'], ['algo', 'pw_algo', 'text'], ['iter', 'pw_iter', 'int']])],
      code: ['code', T.group([['hash', 'code_hash', 'text'], ['purpose', 'code_purpose', 'text'], ['expiresAt', 'code_expires_at', 'ts']])],
      revoked: ['revoked', T.bool], createdAt: ['created_at', T.ts], activatedAt: ['activated_at', T.ts]
    },
    session: { tokenHash: ['token_hash', T.text], role: ['role', T.text], createdAt: ['created_at', T.ts], expiresAt: ['expires_at', T.ts] },
    throttle: { n: ['fails', T.int], first: ['first_at', T.ts], until: ['locked_until', T.ts] },
    delegation: {
      id: ['id', T.text], schoolId: ['school_id', T.text], granteeId: ['grantee_id', T.text], grantorId: ['grantor_id', T.text], grantorName: ['grantor_name', T.text],
      perms: ['perms', T.json], allDepts: ['all_depts', T.bool], deptIds: ['dept_ids', T.json], startDate: ['start_date', T.date], endDate: ['end_date', T.date],
      status: ['status', T.oneOf('active', 'revoked', 'suspended')], note: ['note', T.text], createdAt: ['created_at', T.ts], updatedAt: ['updated_at', T.ts], history: ['history', T.json]
    },
    // جدول المدرسة: سطر لكل (مدرسة، نوع، معرّف) — الإعدادات والمسودة والنسخ والتفعيلات
    // تكليفات الإدارة للحصص المحالة إليها (سطر لكل قيد: إسناد أو تعذّر، والملغاة تبقى)
    adminAssign: { id: ['id', T.text], schoolId: ['school_id', T.text], date: ['date', T.date], ref: ['ref', T.text], srcDeptId: ['src_dept_id', T.text], toDeptId: ['to_dept_id', T.text],
      teacherId: ['teacher_id', T.text], state: ['state', T.text], at: ['at', T.ts] },
    // طلبات تبديل الحصص المؤقتة (سطر لكل طلب، والمغلقة تبقى في السجل)
    swap: { id: ['id', T.text], schoolId: ['school_id', T.text], date: ['date', T.date], kind: ['kind', T.text], status: ['status', T.text], createdAt: ['created_at', T.ts] },
    // بلاغات الحضور لليوم الدراسي القادم (سطر واحد لكل معلم وتاريخ؛ القيد الفريد في القاعدة)
    att: { id: ['id', T.text], schoolId: ['school_id', T.text], deptId: ['dept_id', T.text], teacherId: ['teacher_id', T.text], date: ['date', T.date], status: ['status', T.oneOf('present', 'late', 'absent')],
      by: ['reporter_id', T.text], createdAt: ['created_at', T.ts], at: ['updated_at', T.ts] },
    timetable: { schoolId: ['school_id', T.sref], kind: ['kind', T.oneOf('config', 'settings', 'draft', 'version', 'import', 'activation')], id: ['id', T.text], at: ['at', T.ts], by: ['by_name', T.text], data: ['data', T.json] },
    school: { id: ['id', T.text], name: ['name', T.text], status: ['status', T.oneOf('active', 'inactive')], createdAt: ['created_at', T.ts], importProfile: ['import_profile', T.json] },
    dept: {
      id: ['id', T.text], name: ['name', T.text], school: ['school', T.text], schoolId: ['school_id', T.sref], status: ['status', T.oneOf('active', 'inactive')],
      headTeacherId: ['head_teacher_id', T.tref], importProfile: ['import_profile', T.json], legacyMaxDate: ['legacy_max_date', T.date],
      journalSince: ['journal_since', T.ts], demo: ['demo', T.bool], createdAt: ['created_at', T.ts]
    },
    teacher: {
      id: ['id', T.text], deptId: ['dept_id', T.text], name: ['name', T.text], status: ['status', T.text], inRotation: ['in_rotation', T.bool],
      rotationOrder: ['rotation_order', T.int], demo: ['demo', T.bool], createdAt: ['created_at', T.ts]
    },
    state: {
      confirmed: ['confirmed', T.bool], pointer: ['pointer', T.tref], pendingSeq: ['pending_seq', T.int], manualNext: ['manual_next', T.json],
      version: ['version', T.int], lastChangeId: ['last_change_id', T.text], epoch: ['epoch', T.int], resetAt: ['reset_at', T.ts], resetBy: ['reset_by', T.text],
      openingSource: ['opening_source', T.text]
    },
    pending: { teacherId: ['teacher_id', T.tref], seq: ['seq', T.int], since: ['since', T.date] },
    schedule: {
      version: ['version', T.int], approvedAt: ['approved_at', T.ts], approvedBy: ['approved_by', T.text], days: ['days', T.json],
      periodsByDay: ['periods_by_day', T.json], teacherIds: ['teacher_ids', T.json], source: ['source', T.json]
    },
    entry: { teacherId: ['teacher_id', T.text], day: ['day', T.text], period: ['period', T.int], type: ['type', T.text], cls: ['cls', T.text], raw: ['raw', T.text], ref: ['ref', T.text] },
    exclusion: {
      id: ['id', T.text], teacherId: ['teacher_id', T.text], date: ['date', T.date], scope: ['scope', T.text], periods: ['periods', T.json], status: ['status', T.text],
      reason: ['reason', T.text], note: ['note', T.text], createdBy: ['created_by', T.text], createdAt: ['created_at', T.ts]
    },
    day: {
      id: ['id', T.text], date: ['date', T.date], dayKey: ['day_key', T.text], noAbsence: ['no_absence', T.bool], epoch: ['epoch', T.int],
      scheduleVersion: ['schedule_version', T.int], stateVersion: ['state_version', T.int], approvedBy: ['approved_by', T.text], approvedRole: ['approved_role', T.text],
      approvedAt: ['approved_at', T.ts], correctedAt: ['corrected_at', T.ts], demo: ['demo', T.bool]
    },
    dayVersion: { no: ['no', T.int], kind: ['kind', T.text], at: ['at', T.ts], by: ['by_name', T.text], role: ['role', T.text] },
    journal: {
      id: ['id', T.text], teacherId: ['teacher_id', T.text], at: ['at', T.ts], date: ['date', T.date], kind: ['kind', T.text], before: ['before', T.int],
      after: ['after', T.int], delta: ['delta', T.int], ref: ['ref', T.text], actor: ['actor', T.text]
    },
    backup: {
      id: ['id', T.text], at: ['at', T.ts], actor: ['actor', T.text], role: ['role', T.text], action: ['action', T.text], description: ['description', T.text],
      snapshot: ['snapshot', T.json], undone: ['undone', T.bool]
    },
    cleared: { date: ['date', T.date], epoch: ['epoch', T.int], clearedAt: ['cleared_at', T.ts], clearedBy: ['cleared_by', T.text], record: ['record', T.json] },
    audit: { id: ['id', T.text], at: ['at', T.ts], actor: ['actor', T.text], role: ['role', T.text], action: ['action', T.text], deptId: ['dept_id', T.text], details: ['details', T.text] }
  };

  // الجداول: المفتاح الأساسي، وهل لها معرّف ثابت (ترتيب pos عام) أم موضعية داخل أصلها
  const TABLES = {
    meta: { pk: ['id'] },
    schools: { pk: ['id'], ided: true },
    delegations: { pk: ['id'], ided: true },
    school_timetables: { pk: ['school_id', 'kind', 'id'], ided: true },
    admin_assignments: { pk: ['id'], ided: true },
    swaps: { pk: ['id'], ided: true },
    attendance_reports: { pk: ['id'], ided: true },
    users: { pk: ['id'], ided: true },
    sessions: { pk: ['token_hash'], ided: true },
    auth_throttle: { pk: ['key'], ided: true },
    departments: { pk: ['id'], ided: true },
    teachers: { pk: ['id'], ided: true },
    department_deputies: { pk: ['dept_id', 'teacher_id'] },
    dept_state: { pk: ['dept_id'] },
    teacher_debts: { pk: ['dept_id', 'teacher_id'] },
    pending_rights: { pk: ['dept_id', 'pos'] },
    rotation_skips: { pk: ['dept_id', 'pos'] },
    early_turns: { pk: ['dept_id', 'pos'] },
    schedule_versions: { pk: ['dept_id', 'version'] },
    schedule_entries: { pk: ['dept_id', 'version', 'pos'] },
    exclusions: { pk: ['id'], ided: true },
    days: { pk: ['id'], ided: true },
    day_versions: { pk: ['day_id', 'pos'] },
    day_absences: { pk: ['day_id', 'pos'], derived: true },
    day_assignments: { pk: ['day_id', 'pos'], derived: true },
    debt_journal: { pk: ['id'], ided: true },
    backups: { pk: ['id'], ided: true },
    cleared_days: { pk: ['dept_id', 'pos'] },
    audit_log: { pk: ['id'], ided: true }
  };
  // ترتيب الكتابة: الحذف من الأبناء إلى الآباء، والإضافة من الآباء إلى الأبناء (العلاقات مؤجلة التحقق أيضًا)
  const ORDER = ['meta', 'schools', 'departments', 'teachers', 'users', 'sessions', 'auth_throttle', 'delegations', 'school_timetables', 'department_deputies', 'dept_state', 'teacher_debts', 'pending_rights',
    'rotation_skips', 'early_turns', 'schedule_versions', 'schedule_entries', 'exclusions', 'days', 'day_versions', 'day_absences', 'day_assignments',
    'debt_journal', 'backups', 'cleared_days', 'admin_assignments', 'swaps', 'attendance_reports', 'audit_log'];
  const TOP_KEYS = ['schema', 'meta', 'admin', 'departments', 'teachers', 'accounts', 'sessions', 'days', 'audit', 'throttle', 'schools', 'delegations', 'timetables', 'adminAssigns', 'swaps', 'attReports'];
  const ROLE_OF = { deputy: 'deputy', principal: 'principal', assistant: 'assistant', teacher: 'teacher' };
  const DEPT_HEAVY = ['scheduleVersions', 'exclusions', 'backups', 'debtJournal', 'clearedLedger'];

  const isArr = Array.isArray;
  const isPlain = v => v && typeof v === 'object' && !isArr(v);
  const pkOf = (t, row) => TABLES[t].pk.map(k => String(row[k])).join('\u0001');

  /* ---------- من بيانات الخادم إلى سطور الجداول ----------
     كل سطر: { t: الجدول, part: القسم/المجموعة, row } */
  function toRows(db) {
    for (const k of Object.keys(db)) if (!TOP_KEYS.includes(k)) throw new Error('حقل غير معروف في البيانات: ' + k);
    const out = [];
    const push = (t, part, row) => out.push({ t, part, row });
    const teacherIds = new Set((db.teachers || []).map(t => t.id));
    const cx = { teacherIds, schoolIds: new Set((db.schools || []).map(x => x && x.id).filter(x => typeof x === 'string')) };
    // meta
    const m = encodeObj(db.meta || {}, C.meta, cx);
    m.extra.top = Object.keys(db);
    push('meta', 'G', { id: 1, schema_version: db.schema, ...m });
    // المدارس
    for (const sc of db.schools || []) { const r = encodeObj(sc, C.school, cx); if (r.id == null) throw new Error('مدرسة بلا معرّف'); push('schools', 'G', r); }
    // users
    if (db.admin) push('users', 'G', { ...encodeObj(db.admin, C.user, cx), id: 'admin', role: 'organizer' });
    for (const a of db.accounts || []) {
      const r = encodeObj(a, C.user, cx);
      if (r.id == null) throw new Error('حساب بلا معرّف');
      push('users', 'G', { ...r, role: ROLE_OF[a.kind] || 'head' });
    }
    for (const g of db.delegations || []) { const r = encodeObj(g, C.delegation, cx); if (r.id == null) throw new Error('تفويض بلا معرّف'); push('delegations', 'G', r); }
    for (const x of db.timetables || []) { const r = encodeObj(x, C.timetable, cx); if (r.school_id == null || r.kind == null || r.id == null) throw new Error('سطر جدول مدرسة غير صالح'); push('school_timetables', 'T:' + r.school_id, r); }
    for (const s of db.sessions || []) push('sessions', 'G', { ...encodeObj(s, C.session, cx), user_id: s.accountId || 'admin' });
    for (const x of db.adminAssigns || []) { const r = encodeObj(x, C.adminAssign, cx); if (typeof r.id !== 'string' || typeof r.school_id !== 'string') throw new Error('تكليف إدارة غير صالح'); push('admin_assignments', 'Q:' + r.school_id, r); }
    for (const x of db.attReports || []) { const r = encodeObj(x, C.att, cx); if (typeof r.id !== 'string' || typeof r.teacher_id !== 'string' || !r.date || !r.status) throw new Error('بلاغ حضور غير صالح'); push('attendance_reports', 'V:' + r.date, r); }
    for (const x of db.swaps || []) { const r = encodeObj(x, C.swap, cx); if (typeof r.id !== 'string' || typeof r.school_id !== 'string') throw new Error('طلب تبديل غير صالح'); push('swaps', 'W:' + r.school_id, r); }
    for (const [key, e] of Object.entries(db.throttle || {})) push('auth_throttle', 'G', { key, ...encodeObj(e, C.throttle, cx) });
    // الأقسام
    for (const dep of db.departments || []) {
      const L = 'L:' + dep.id, H = 'H:' + dep.id, S = 'S:' + dep.id;
      const dIds = dep.deputyTeacherIds;
      const okDeps = isArr(dIds) && dIds.every(x => typeof x === 'string' && teacherIds.has(x)) && new Set(dIds).size === dIds.length;
      // الجدول المعتمد وإصداراته
      const versions = isArr(dep.scheduleVersions) ? dep.scheduleVersions : null;
      const okVersions = !!versions && versions.every(v => isPlain(v) && isInt(v.version) && isArr(v.entries)) && new Set(versions.map(v => v.version)).size === versions.length;
      const ap = dep.scheduleApproved;
      let okAp = ap === null || ap === undefined;
      let apInVersions = false;
      if (isPlain(ap) && isInt(ap.version) && isArr(ap.entries) && okVersions) {
        const same = versions.find(v => v.version === ap.version);
        if (same) { okAp = JSON.stringify(same) === JSON.stringify(ap); apInVersions = okAp; }
        else okAp = true; // التحميل الخفيف: الإصدار الحالي وحده دون بقية الإصدارات
      }
      const kids = {
        deputyTeacherIds: okDeps, scheduleVersions: okVersions, scheduleApproved: okAp, state: isPlain(dep.state),
        exclusions: isArr(dep.exclusions) && dep.exclusions.every(x => isPlain(x) && typeof x.id === 'string'),
        backups: isArr(dep.backups) && dep.backups.every(x => isPlain(x) && typeof x.id === 'string'),
        debtJournal: isArr(dep.debtJournal) && dep.debtJournal.every(x => isPlain(x) && typeof x.id === 'string'),
        clearedLedger: isArr(dep.clearedLedger) && dep.clearedLedger.every(isPlain)
      };
      const r = encodeObj(dep, C.dept, cx, { children: kids });
      r.current_schedule_version = isPlain(ap) && kids.scheduleApproved ? ap.version : null;
      push('departments', L, r);
      if (okDeps && dIds) dIds.forEach((id, i) => push('department_deputies', L, { dept_id: dep.id, teacher_id: id, pos: i }));
      const vlist = (okVersions ? versions.slice() : []);
      if (isPlain(ap) && kids.scheduleApproved && !apInVersions) vlist.push(ap);
      vlist.forEach((v, i) => {
        const vr = encodeObj(v, C.schedule, cx, { children: { entries: true } });
        push('schedule_versions', S, { dept_id: dep.id, pos: okVersions && versions.includes(v) ? versions.indexOf(v) : -1, ...vr });
        v.entries.forEach((e, j) => push('schedule_entries', S, { dept_id: dep.id, version: v.version, pos: j, ...(isPlain(e) ? encodeObj(e, C.entry, cx) : { extra: { k: [], v: e } }) }));
      });
      // حالة الدور
      if (kids.state) {
        const st = dep.state;
        const okDebts = isPlain(st.debts) && Object.keys(st.debts).every(k => teacherIds.has(k));
        const okPending = isArr(st.pending) && st.pending.every(isPlain);
        const okSkips = isArr(st.skips), okEarly = isArr(st.earlyTurns);
        const sr = encodeObj(st, C.state, cx, { children: { debts: okDebts, pending: okPending, skips: okSkips, earlyTurns: okEarly } });
        push('dept_state', L, { dept_id: dep.id, ...sr });
        if (okDebts) Object.keys(st.debts).forEach((k, i) => { const v = st.debts[k]; push('teacher_debts', L, { dept_id: dep.id, teacher_id: k, pos: i, balance: isInt(v) ? v : null, extra: isInt(v) ? null : { v } }); });
        if (okPending) st.pending.forEach((p, i) => push('pending_rights', L, { dept_id: dep.id, pos: i, ...encodeObj(p, C.pending, cx) }));
        if (okSkips) st.skips.forEach((x, i) => push('rotation_skips', L, { dept_id: dep.id, pos: i, teacher_id: typeof x === 'string' ? x : null, raw: typeof x === 'string' ? null : { v: x } }));
        if (okEarly) st.earlyTurns.forEach((x, i) => push('early_turns', L, { dept_id: dep.id, pos: i, teacher_id: typeof x === 'string' ? x : null, raw: typeof x === 'string' ? null : { v: x } }));
      }
      if (kids.exclusions) for (const x of dep.exclusions) push('exclusions', H, { dept_id: dep.id, ...encodeObj(x, C.exclusion, cx) });
      if (kids.backups) for (const x of dep.backups) push('backups', H, { dept_id: dep.id, ...encodeObj(x, C.backup, cx) });
      if (kids.debtJournal) for (const x of dep.debtJournal) push('debt_journal', H, { dept_id: dep.id, ...encodeObj(x, C.journal, cx) });
      if (kids.clearedLedger) dep.clearedLedger.forEach((x, i) => push('cleared_days', H, { dept_id: dep.id, pos: i, ...encodeObj(x, C.cleared, cx) }));
    }
    for (const t of db.teachers || []) push('teachers', 'L:' + t.deptId, encodeObj(t, C.teacher, cx));
    const deptIds = new Set((db.departments || []).map(x => x.id));
    for (const d of db.days || []) {
      if (typeof d.id !== 'string' || !deptIds.has(d.deptId)) throw new Error('يوم معتمد بلا معرّف أو بلا قسم صالح');
      const H = 'H:' + d.deptId;
      const okV = isArr(d.versions) && d.versions.every(isPlain);
      const r = encodeObj(d, C.day, cx, { children: { versions: okV } });
      push('days', H, { dept_id: d.deptId, ...r });
      if (okV) d.versions.forEach((v, i) => push('day_versions', H, { day_id: d.id, pos: i, ...encodeObj(v, C.dayVersion, cx) }));
      // عروض مشتقة للاستعلام: الغياب والتكليفات وحالة تنفيذها
      try {
        (isArr(d.absentIds) ? d.absentIds : []).forEach((id, i) => push('day_absences', H, { day_id: d.id, pos: i, dept_id: d.deptId, date: d.date, teacher_id: typeof id === 'string' ? id : null, periods: (d.absentPeriods || {})[id] || null }));
        const slots = (d.result && isArr(d.result.slots)) ? d.result.slots : [];
        slots.forEach((s, i) => push('day_assignments', H, {
          day_id: d.id, pos: i, slot_key: s.key || null, dept_id: d.deptId, date: d.date, period: isInt(s.period) ? s.period : null, cls: s.cls == null ? null : String(s.cls),
          absent_teacher_id: s.absentId || null, substitute_teacher_id: s.teacherId || null, source: s.source || null, kind: s.kind || null, status: s.status || null,
          execution: d.marks && s.key ? d.marks[s.key] || null : null
        }));
      } catch (e) { /* العرض المشتق لا يمنع الحفظ */ }
    }
    for (const a of db.audit || []) push('audit_log', a.deptId && deptIds.has(a.deptId) ? 'H:' + a.deptId : (a.deptId ? 'X:' + a.deptId : 'A'), encodeObj(a, C.audit, cx));
    return out;
  }

  /* ---------- من سطور الجداول إلى بيانات الخادم ---------- */
  function fromRows(R, lightDepts) {
    lightDepts = lightDepts || new Set();
    const by = (t, key) => { const m = new Map(); for (const r of R[t] || []) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
    const sortPos = a => a.slice().sort((x, y) => x.pos - y.pos);
    const metaRow = R.meta[0];
    const db = { schema: metaRow.schema_version, meta: decodeObj(metaRow, C.meta) };
    const users = sortPos(R.users || []);
    const adminRow = users.find(u => u.role === 'organizer');
    db.admin = adminRow ? decodeObj(adminRow, C.user) : null;
    const debtsBy = by('teacher_debts', r => r.dept_id), pendBy = by('pending_rights', r => r.dept_id), skipBy = by('rotation_skips', r => r.dept_id), earlyBy = by('early_turns', r => r.dept_id);
    const depBy = by('department_deputies', r => r.dept_id), stateBy = by('dept_state', r => r.dept_id);
    const verBy = by('schedule_versions', r => r.dept_id), entBy = by('schedule_entries', r => r.dept_id + '\u0001' + r.version);
    const exBy = by('exclusions', r => r.dept_id), bkBy = by('backups', r => r.dept_id), jrBy = by('debt_journal', r => r.dept_id), clBy = by('cleared_days', r => r.dept_id);
    const unv = r => { const x = typeof r === 'object' && r !== null ? r : null; return x && Object.prototype.hasOwnProperty.call(x, 'v') ? x.v : undefined; };
    db.departments = sortPos(R.departments || []).map(r => {
      const id = r.id;
      const verRows = (verBy.get(id) || []);
      const decV = vr => decodeObj(vr, C.schedule, { entries: sortPos(entBy.get(id + '\u0001' + vr.version) || []).map(e => (e.extra && e.extra.k && e.extra.k.length === 0 && 'v' in e.extra) ? e.extra.v : decodeObj(e, C.entry)) });
      const listed = lightDepts.has(id) ? [] : verRows.filter(v => v.pos >= 0).sort((a, b) => a.pos - b.pos).map(decV);
      const cur = r.current_schedule_version;
      let approved = null;
      if (cur != null) { const vr = verRows.find(v => v.version === cur); approved = vr ? decV(vr) : null; }
      const st = (stateBy.get(id) || [])[0];
      const state = st ? decodeObj(st, C.state, {
        debts: Object.fromEntries(sortPos(debtsBy.get(id) || []).map(d => [d.teacher_id, d.balance != null ? d.balance : unv(d.extra)])),
        pending: sortPos(pendBy.get(id) || []).map(p => decodeObj(p, C.pending)),
        skips: sortPos(skipBy.get(id) || []).map(x => x.teacher_id != null ? x.teacher_id : unv(x.raw)),
        earlyTurns: sortPos(earlyBy.get(id) || []).map(x => x.teacher_id != null ? x.teacher_id : unv(x.raw))
      }) : undefined;
      const kids = {
        deputyTeacherIds: sortPos(depBy.get(id) || []).map(x => x.teacher_id),
        scheduleVersions: listed, scheduleApproved: approved,
        exclusions: sortPos(exBy.get(id) || []).map(x => decodeObj(x, C.exclusion)),
        backups: sortPos(bkBy.get(id) || []).map(x => decodeObj(x, C.backup)),
        debtJournal: sortPos(jrBy.get(id) || []).map(x => decodeObj(x, C.journal)),
        clearedLedger: sortPos(clBy.get(id) || []).map(x => decodeObj(x, C.cleared))
      };
      if (state !== undefined) kids.state = state;
      return decodeObj(r, C.dept, kids);
    });
    db.teachers = sortPos(R.teachers || []).map(r => decodeObj(r, C.teacher));
    db.schools = sortPos(R.schools || []).map(r => decodeObj(r, C.school));
    db.delegations = sortPos(R.delegations || []).map(r => decodeObj(r, C.delegation));
    db.timetables = sortPos(R.school_timetables || []).map(r => decodeObj(r, C.timetable));
    db.adminAssigns = sortPos(R.admin_assignments || []).map(r => decodeObj(r, C.adminAssign));
    db.swaps = sortPos(R.swaps || []).map(r => decodeObj(r, C.swap));
    db.attReports = sortPos(R.attendance_reports || []).map(r => decodeObj(r, C.att));
    db.accounts = users.filter(u => u.role !== 'organizer').map(r => decodeObj(r, C.user));
    db.sessions = sortPos(R.sessions || []).map(r => decodeObj(r, C.session));
    const dvBy = by('day_versions', r => r.day_id);
    db.days = sortPos(R.days || []).map(r => decodeObj(r, C.day, { versions: sortPos(dvBy.get(r.id) || []).map(v => decodeObj(v, C.dayVersion)) }));
    db.audit = sortPos(R.audit_log || []).map(r => decodeObj(r, C.audit));
    db.throttle = Object.fromEntries(sortPos(R.auth_throttle || []).map(r => [r.key, decodeObj(r, C.throttle)]));
    // ترتيب المفاتيح العليا كما في النسخة الأصلية
    const top = metaRow.extra && metaRow.extra.top;
    if (isArr(top)) { const o = {}; for (const k of top) if (k in db) o[k] = db[k]; for (const k in db) if (!(k in o)) o[k] = db[k]; return o; }
    return db;
  }

  // ---------- التطبيع للمقارنة بعد القراءة ----------
  function colTypes(sql) { return sql`select table_name, column_name, data_type from information_schema.columns where table_schema = ${SCHEMA}`; }
  function normVal(v, type) {
    if (v == null) return null;
    if (type === 'timestamp with time zone') return tsOut(v);
    if (type === 'date') return dateOut(v);
    if (type === 'json' || type === 'jsonb') return JSON.stringify(v);
    if (type === 'integer' || type === 'bigint' || type === 'smallint') return Number(v);
    return v;
  }

  // ---------- التحميل ----------
  const Q = (sql, text, params) => sql.unsafe(text, params || []);
  async function loadRows(sql, planIn) {
    const R = {};
    const all = async t => { R[t] = await Q(sql, `select * from ${SCHEMA}.${t} order by ${TABLES[t].pk.includes('pos') ? 'pos' : (TABLES[t].ided ? 'pos' : TABLES[t].pk.join(','))}`); };
    await Promise.all(['meta', 'schools', 'delegations', 'users', 'sessions', 'auth_throttle', 'departments', 'teachers', 'department_deputies', 'dept_state', 'teacher_debts', 'pending_rights', 'rotation_skips', 'early_turns'].map(all));
    if (!R.meta.length) throw new Error('قاعدة البيانات غير مهيأة: طبّق ملف الإنشاء أولًا.');
    const plan = typeof planIn === 'function' ? await planIn(fromRows({ ...R, schedule_versions: [], schedule_entries: [] }, new Set(R.departments.map(d => d.id)))) : planIn;
    const heavy = plan.allHeavy ? R.departments.map(d => d.id) : [...plan.heavy].filter(id => R.departments.some(d => d.id === id));
    const light = R.departments.map(d => d.id).filter(id => !heavy.includes(id));
    // الإصدار الحالي للجدول (دون الخانات) للأقسام غير المحمّلة بالكامل
    R.schedule_versions = []; R.schedule_entries = []; R.exclusions = []; R.backups = []; R.debt_journal = []; R.cleared_days = []; R.days = []; R.day_versions = []; R.audit_log = [];
    // جدول المدرسة: يُحمَّل لمدارس العملية فقط (أو كله في التحميل الكامل)
    const ttSchools = plan.allHeavy ? R.schools.map(x => x.id) : [...(plan.ttSchools || [])].filter(id => R.schools.some(x => x.id === id));
    R.school_timetables = ttSchools.length ? await Q(sql, `select * from ${SCHEMA}.school_timetables where school_id = any($1) order by pos`, [ttSchools]) : [];
    // تكليفات الإدارة: لمدارس الأقسام المحمّلة كاملة ومدارس العملية (توفر المعلمين وروابط الإحالات)
    const aaSet = new Set(plan.allHeavy ? R.schools.map(x => x.id) : [...(plan.aaSchools || [])]);
    if (!plan.allHeavy) for (const id of heavy) { const dep = R.departments.find(d => d.id === id); if (dep && dep.school_id) aaSet.add(dep.school_id); }
    const aaSchools = [...aaSet].filter(id => R.schools.some(x => x.id === id));
    R.admin_assignments = aaSchools.length ? await Q(sql, `select * from ${SCHEMA}.admin_assignments where school_id = any($1) order by pos`, [aaSchools]) : [];
    // طلبات التبديل: للمدارس نفسها (الجدول الفعلي للتاريخ يحتاجها في التوزيع والتوفر والعرض)
    R.swaps = aaSchools.length ? await Q(sql, `select * from ${SCHEMA}.swaps where school_id = any($1) order by pos`, [aaSchools]) : [];
    // بلاغات الحضور: من أول الشهر الحالي (توقيت الكويت) أو من قبل يومين أيهما أبكر — حد الاستئذان الشهري يعدّ استئذانات الشهر كله —
    // وتواريخ محددة تطلبها العملية (عرض تاريخ سابق). العدد صغير (معلمو المدرسة × أيام شهر)
    const kwMonth1 = new Date(Date.now() + 3 * 36e5).toISOString().slice(0, 8) + '01';
    const ago2 = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
    const attFrom = plan.attFrom || (kwMonth1 < ago2 ? kwMonth1 : ago2);
    const attDates = [...(plan.attDates || [])].filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x));
    R.attendance_reports = await Q(sql, `select * from ${SCHEMA}.attendance_reports where date >= $1 or date = any($2::date[]) order by pos`, [attFrom, attDates]);
    if (light.length) R.schedule_versions = R.schedule_versions.concat(await Q(sql, `select sv.* from ${SCHEMA}.schedule_versions sv join ${SCHEMA}.departments d on d.id = sv.dept_id and d.current_schedule_version = sv.version where sv.dept_id = any($1)`, [light]));
    // التذكيرات (قراءة فقط): حصص الجدول الساري لكل الأقسام لتذكير «قبل حصة التدريس»
    if (plan.lightEntries && light.length) R.schedule_entries = R.schedule_entries.concat(await Q(sql, `select se.* from ${SCHEMA}.schedule_entries se join ${SCHEMA}.departments d on d.id = se.dept_id and d.current_schedule_version = se.version where se.dept_id = any($1) order by se.pos`, [light]));
    if (heavy.length) {
      const [sv, se, ex, bk, jr, cl, dy, dv, au] = await Promise.all([
        Q(sql, `select * from ${SCHEMA}.schedule_versions where dept_id = any($1) order by pos`, [heavy]),
        Q(sql, `select * from ${SCHEMA}.schedule_entries where dept_id = any($1) order by pos`, [heavy]),
        Q(sql, `select * from ${SCHEMA}.exclusions where dept_id = any($1) order by pos`, [heavy]),
        Q(sql, `select * from ${SCHEMA}.backups where dept_id = any($1) order by pos`, [heavy]),
        Q(sql, `select * from ${SCHEMA}.debt_journal where dept_id = any($1) order by pos`, [heavy]),
        Q(sql, `select * from ${SCHEMA}.cleared_days where dept_id = any($1) order by pos`, [heavy]),
        Q(sql, `select * from ${SCHEMA}.days where dept_id = any($1) order by pos`, [heavy]),
        Q(sql, `select v.* from ${SCHEMA}.day_versions v join ${SCHEMA}.days d on d.id = v.day_id where d.dept_id = any($1) order by v.pos`, [heavy]),
        Q(sql, `select * from ${SCHEMA}.audit_log where dept_id = any($1) order by pos`, [heavy])
      ]);
      Object.assign(R, { schedule_versions: R.schedule_versions.concat(sv), schedule_entries: se, exclusions: ex, backups: bk, debt_journal: jr, cleared_days: cl, days: dy, day_versions: dv, audit_log: au });
    }
    const readonly = new Set();
    // لوحة المدير: أيام اليوم وما بعده لكل الأقسام الأخرى (قراءة فقط)
    if (plan.daysFrom && light.length) {
      const dy = await Q(sql, `select * from ${SCHEMA}.days where dept_id = any($1) and date >= $2 order by pos`, [light, plan.daysFrom]);
      const dv = dy.length ? await Q(sql, `select * from ${SCHEMA}.day_versions where day_id = any($1) order by pos`, [dy.map(d => d.id)]) : [];
      R.days = R.days.concat(dy).sort((a, b) => a.pos - b.pos); R.day_versions = R.day_versions.concat(dv);
      for (const id of light) readonly.add('H:' + id);
    }
    if (plan.allHeavy || plan.auditAll) {
      const au = plan.allHeavy
        ? await Q(sql, `select * from ${SCHEMA}.audit_log where dept_id is null or not (dept_id = any($1)) order by pos`, [heavy])
        : await Q(sql, `select * from (select * from ${SCHEMA}.audit_log where not (coalesce(dept_id, '') = any($1)) order by pos desc limit 500) x order by pos`, [heavy]);
      R.audit_log = R.audit_log.concat(au).sort((a, b) => a.pos - b.pos);
      if (!plan.allHeavy) { readonly.add('A'); for (const d of R.departments) if (!heavy.includes(d.id)) readonly.add('H:' + d.id); readonly.add('X'); }
    }
    // الأجزاء المحمّلة كاملة (يجوز فيها التعديل والحذف)
    const loaded = new Set(['G']);
    for (const d of R.departments) loaded.add('L:' + d.id);
    for (const id of heavy) { loaded.add('H:' + id); loaded.add('S:' + id); }
    for (const id of ttSchools) loaded.add('T:' + id);
    for (const id of aaSchools) { loaded.add('Q:' + id); loaded.add('W:' + id); }
    for (const r of R.attendance_reports) loaded.add('V:' + (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10)));
    if (plan.allHeavy) { loaded.add('A'); for (const r of R.audit_log) if (r.dept_id && !R.departments.some(d => d.id === r.dept_id)) loaded.add('X:' + r.dept_id); }
    for (const p of readonly) loaded.delete(p);
    return { R, loaded, readonly, heavy, plan, light: new Set(light) };
  }

  // ---------- الكتابة ----------
  function partReadonly(part, readonly) { return readonly.has(part) || (part.startsWith('X:') && readonly.has('X')) || (part === 'A' && readonly.has('A')); }

  /* الفروق بين قبل وبعد. يُسمح بالتعديل والحذف فقط في الأجزاء المحمّلة كاملة؛
     خارجها لا يُسمح إلا بإضافة سطر جديد (والمفتاح الأساسي يمنع التكرار). */
  function diff(beforeRows, afterRows, loaded, readonly, storedPos) {
    const B = new Map(), A = new Map();
    for (const x of beforeRows) B.set(x.t + '\u0002' + pkOf(x.t, x.row), x);
    for (const x of afterRows) {
      const k = x.t + '\u0002' + pkOf(x.t, x.row);
      if (A.has(k)) throw new Error(`سطر مكرر في ${x.t}: ${pkOf(x.t, x.row)}`);
      A.set(k, x);
    }
    const ins = [], upd = [], del = [];
    for (const [k, x] of A) {
      const b = B.get(k);
      if (!b) { if (partReadonly(x.part, readonly)) throw new Error('محاولة كتابة في بيانات محمّلة للقراءة فقط: ' + x.t); ins.push(x); }
      else if (JSON.stringify(b.row) !== JSON.stringify(x.row)) {
        if (!loaded.has(x.part)) throw new Error('محاولة تعديل بيانات غير محمّلة: ' + x.t);
        if (b.part !== x.part && !loaded.has(b.part)) throw new Error('محاولة نقل سطر من بيانات غير محمّلة: ' + x.t);
        upd.push({ before: b, after: x });
      }
    }
    for (const [k, b] of B) if (!A.has(k)) {
      if (!loaded.has(b.part)) throw new Error('محاولة حذف من بيانات غير محمّلة: ' + b.t);
      del.push(b);
    }
    return { ins, upd, del };
  }

  // ترتيب ثابت (pos) للجداول ذات المعرّف: السطر القديم يحتفظ بموضعه، والجديد بعد آخر موضع في الجدول
  async function assignPositions(sql, afterRows, storedPos) {
    const byT = new Map();
    for (const x of afterRows) if (TABLES[x.t].ided) { if (!byT.has(x.t)) byT.set(x.t, []); byT.get(x.t).push(x); }
    for (const [t, list] of byT) {
      const sp = storedPos[t] || new Map();
      let increasing = true, last = -Infinity, sawNew = false;
      for (const x of list) {
        const p = sp.get(pkOf(t, x.row));
        if (p === undefined) { sawNew = true; continue; }
        if (sawNew || p <= last) { increasing = false; break; }
        last = p;
      }
      const needNew = !increasing || list.some(x => !sp.has(pkOf(t, x.row)));
      let next = 0;
      if (needNew) { const [{ m }] = await Q(sql, `select coalesce(max(pos), -1) as m from ${SCHEMA}.${t}`); next = Math.max(Number(m), ...[...sp.values(), -1]) + 1; }
      for (const x of list) {
        const p = sp.get(pkOf(t, x.row));
        x.row.pos = increasing && p !== undefined ? p : next++;
      }
    }
  }

  async function columnsOf(sql) {
    if (columnsOf.cache) return columnsOf.cache;
    const rows = await colTypes(sql); const m = {};
    for (const r of rows) (m[r.table_name] = m[r.table_name] || {})[r.column_name] = r.data_type;
    columnsOf.cache = m; return m;
  }
  const UNMANAGED = { meta: ['rev', 'updated_at'] };
  const managed = (t, cols) => Object.keys(cols[t]).filter(c => !(UNMANAGED[t] || []).includes(c));
  function cleanRow(t, row, cols) { const o = {}; for (const c of managed(t, cols)) o[c] = row[c] === undefined ? null : row[c]; return o; }

  async function applyDiff(sql, D) {
    const cols = await columnsOf(sql);
    const groups = (list, f) => { const m = new Map(); for (const x of list) { const t = f(x); if (!m.has(t)) m.set(t, []); m.get(t).push(x); } return m; };
    const delBy = groups(D.del, x => x.t), updBy = groups(D.upd, x => x.after.t), insBy = groups(D.ins, x => x.t);
    for (const t of ORDER.slice().reverse()) {
      const list = delBy.get(t); if (!list) continue;
      const pk = TABLES[t].pk;
      await Q(sql, `delete from ${SCHEMA}.${t} x using json_populate_recordset(null::${SCHEMA}.${t}, $1::text::json) r where ${pk.map(k => `x.${k} = r.${k}`).join(' and ')}`, [JSON.stringify(list.map(x => cleanRow(t, x.row, cols)))]);
    }
    for (const t of ORDER) {
      const list = updBy.get(t); if (!list) continue;
      const pk = TABLES[t].pk; const cs = managed(t, cols).filter(c => !pk.includes(c));
      await Q(sql, `update ${SCHEMA}.${t} x set (${cs.join(',')}) = row(${cs.map(c => 'r.' + c).join(',')}) from json_populate_recordset(null::${SCHEMA}.${t}, $1::text::json) r where ${pk.map(k => `x.${k} = r.${k}`).join(' and ')}`, [JSON.stringify(list.map(x => cleanRow(t, x.after.row, cols)))]);
    }
    for (const t of ORDER) {
      const list = insBy.get(t); if (!list) continue;
      const cs = managed(t, cols);
      await Q(sql, `insert into ${SCHEMA}.${t} (${cs.join(',')}) select ${cs.join(',')} from json_populate_recordset(null::${SCHEMA}.${t}, $1::text::json)`, [JSON.stringify(list.map(x => cleanRow(t, x.row, cols)))]);
    }
  }

  // التحقق بعد الكتابة: كل سطر أُضيف أو عُدّل يُقرأ ويُقارن، وكل سطر حُذف يُتأكد من غيابه
  async function verifyWrite(sql, D) {
    const cols = await columnsOf(sql);
    const want = new Map();
    for (const x of D.ins) want.set(x.t + '\u0002' + pkOf(x.t, x.row), { t: x.t, row: x.row });
    for (const x of D.upd) want.set(x.after.t + '\u0002' + pkOf(x.after.t, x.after.row), { t: x.after.t, row: x.after.row });
    const gone = D.del.filter(x => !want.has(x.t + '\u0002' + pkOf(x.t, x.row)));
    const byT = new Map();
    for (const w of want.values()) { if (!byT.has(w.t)) byT.set(w.t, []); byT.get(w.t).push(w.row); }
    for (const x of gone) { if (!byT.has(x.t)) byT.set(x.t, []); }
    const problems = [];
    for (const [t, rows] of byT) {
      const pk = TABLES[t].pk;
      const keys = rows.map(r => pk.map(k => r[k]));
      const delKeys = gone.filter(x => x.t === t).map(x => pk.map(k => x.row[k]));
      const all = keys.concat(delKeys);
      if (!all.length) continue;
      const found = await Q(sql, `select x.* from ${SCHEMA}.${t} x join json_populate_recordset(null::${SCHEMA}.${t}, $1::text::json) r on ${pk.map(k => `x.${k} = r.${k}`).join(' and ')}`,
        [JSON.stringify(all.map(k => Object.fromEntries(pk.map((c, i) => [c, k[i]]))))]);
      const fmap = new Map(found.map(r => [pkOf(t, r), r]));
      for (const r of rows) {
        const got = fmap.get(pkOf(t, r));
        if (!got) { problems.push(`${t}: سطر لم يُحفظ`); continue; }
        for (const c of managed(t, cols)) {
          const a = normVal(r[c] === undefined ? null : r[c], cols[t][c]), b = normVal(got[c], cols[t][c]);
          if (a !== b) { problems.push(`${t}.${c}: القيمة المحفوظة تختلف`); break; }
        }
      }
      for (const k of delKeys) if (fmap.has(pkOf(t, Object.fromEntries(pk.map((c, i) => [c, k[i]]))))) problems.push(`${t}: سطر لم يُحذف`);
    }
    if (problems.length) throw new Error('فشل التحقق بعد الحفظ: ' + problems.slice(0, 5).join('؛ '));
  }

  /* عزل الأقسام على مستوى الكتابة: رئيس القسم ونوابه لا يغيّرون إلا سطور قسمهم،
     وحسابهم وجلساتهم وسجلات المحاولات. العمليات العامة (الدخول والتفعيل) لا تمس بيانات الأقسام. */
  /* حسابات «معلم» من استيراد Excel (غير المنظّم): إضافة حساب معلم جديد بانتظار التفعيل بلا كلمة مرور في قسم مسموح،
     أو إصدار رمز تفعيل لحساب معلم لم يُفعَّل قط في قسم مسموح (يتغير الرمز وحده). لا حذف، ولا تغيير دور أو قسم أو كلمة مرور. */
  function teacherAccOk(D, x, allowed) {
    const r = x.row;
    if (r.role !== 'teacher' || !allowed(r.dept_id) || r.pw_hash != null || r.pw_salt != null || r.status !== 'pending' || r.activated_at != null) return false;
    if (D.del.includes(x)) return false;
    if (D.ins.includes(x)) return true;
    const u = D.upd.find(y => y.after === x || y.before === x); if (!u) return false;
    const a = u.before.row, b = u.after.row;
    if (a.role !== 'teacher' || a.pw_hash != null || a.status !== 'pending' || a.activated_at != null) return false;
    for (const k of new Set(Object.keys(a).concat(Object.keys(b)))) if (!/^code_/.test(k) && k !== 'pos' && JSON.stringify(a[k] === undefined ? null : a[k]) !== JSON.stringify(b[k] === undefined ? null : b[k])) return false;
    return true;
  }
  function guard(D, who, deptSchool) {
    if (!who || who.role === 'admin') return;
    const touched = D.ins.map(x => x).concat(D.upd.map(x => x.after), D.upd.map(x => x.before), D.del);
    // مدير المدرسة ومساعده: سطور أقسام مدرستهما فقط (القسم يُعرف من البيانات المحفوظة والمكتوبة، لا من الطلب)
    if (who.role === 'school') {
      const inserted = new Set(D.ins), updatedAfter = new Set(D.upd.map(x => x.after)), updatedBefore = new Set(D.upd.map(x => x.before));
      const mine = depId => !!depId && deptSchool.get(depId) === who.schoolId && deptSchool.get('before:' + depId) !== 'other';
      for (const x of touched) {
        const m = /^[LHS]:(.+)$/.exec(x.part || '');
        const ok =
          (x.t === 'auth_throttle') ||
          (x.t === 'users' && x.row.id === who.id) ||
          (x.t === 'users' && teacherAccOk(D, x, mine)) ||
          (x.t === 'sessions' && x.row.user_id === who.id) ||
          (x.t === 'schools' && x.row.id === who.schoolId && (updatedAfter.has(x) || updatedBefore.has(x))) ||
          (x.t === 'delegations' && x.row.school_id === who.schoolId && !D.del.includes(x)) ||
          (x.t === 'school_timetables' && x.row.school_id === who.schoolId) ||
          (x.t === 'admin_assignments' && x.row.school_id === who.schoolId) ||
          (x.t === 'swaps' && x.row.school_id === who.schoolId) ||
          (x.t === 'departments' && x.row.school_id === who.schoolId && mine(x.row.id)) ||
          (x.t === 'audit_log' && (x.row.dept_id ? mine(x.row.dept_id) : inserted.has(x))) ||
          (x.t !== 'departments' && x.t !== 'audit_log' && m && mine(m[1]));
        if (!ok) throw new Error(`رُفضت كتابة خارج نطاق المدرسة (${x.t})`);
      }
      return;
    }
    for (const x of touched) {
      const ok =
        (x.t === 'auth_throttle') ||
        (x.t === 'meta' && who.role === 'public') ||
        (x.t === 'users' && (who.role === 'public' || x.row.id === who.id)) ||
        (who.role === 'head' && x.t === 'users' && teacherAccOk(D, x, id => !!id && (who.taDepts || []).includes(id))) ||
        (x.t === 'sessions' && (who.role === 'public' || x.row.user_id === who.id)) ||
        (x.t === 'audit_log' && (who.role === 'public' ? true : x.row.dept_id === who.deptId || (who.grantDepts || []).includes(x.row.dept_id))) ||
        (who.role === 'head' && x.t === 'school_timetables' && (who.ttSchools || []).includes(x.row.school_id)) ||
        (who.role === 'head' && x.t === 'audit_log' && !x.row.dept_id && D.ins.includes(x) && ((who.ttSchools || []).length > 0 || (who.adSchools || []).length > 0 || (who.blSchools || []).length > 0 || (who.swSchools || []).length > 0)) ||
        // المفوَّض بتوزيع الحصص المحالة للإدارة: تكليفات مدرسته ودور أقسامها (سطر المدرسة دون اسمها وحالتها)
        (who.role === 'head' && x.t === 'admin_assignments' && (who.adSchools || []).includes(x.row.school_id)) ||
        // طلبات التبديل: مدرسة قسم الحساب (المعلم ورئيس القسم ونوابه) أو مدارس تفويض «إدارة طلبات تبديل الحصص»
        (x.t === 'swaps' && (who.role === 'head' || who.role === 'teacher') && x.row.school_id != null && (x.row.school_id === deptSchool.get(who.deptId) || (who.swSchools || []).includes(x.row.school_id))) ||
        (who.role === 'head' && x.t === 'schools' && ((who.adSchools || []).includes(x.row.id) || (who.blSchools || []).includes(x.row.id)) && D.upd.some(u => u.after === x || u.before === x) && sameSchoolCore(D, x)) ||
        (who.role === 'head' && [who.deptId].concat(who.grantDepts || []).some(id => x.part === 'L:' + id || x.part === 'H:' + id || x.part === 'S:' + id)) ||
        // بلاغ الحضور: صاحب الحساب لنفسه فقط (إضافة أو تعديل لسطر كتبه هو)، ولا حذف
        ((who.role === 'head' || who.role === 'teacher') && x.t === 'attendance_reports' && attOk(D, x, who));
      if (!ok) throw new Error(`رُفضت كتابة خارج النطاق المسموح (${x.t})`);
    }
  }

  // بلاغات الحضور: صاحب التعديل هو الحساب نفسه، وداخل قسم الحساب فقط (رئيس القسم ونوابه لمعلمي قسمهم، والمعلم لنفسه)
  function attOk(D, x, who) {
    if (D.del.includes(x)) return false;
    if (!who.deptId || x.row.dept_id !== who.deptId) return false;
    if (D.ins.includes(x) || D.upd.some(u => u.after === x)) return x.row.reporter_id === who.id;
    const u = D.upd.find(y => y.before === x);
    return !!u && u.after.row.reporter_id === who.id && u.after.row.teacher_id === x.row.teacher_id && String(u.after.row.date) === String(x.row.date);
  }
  // تعديل سطر المدرسة من مفوَّض: يُسمح بتغيير دور الأقسام فقط (adminRot في extra) دون الاسم والحالة
  function sameSchoolCore(D, x) {
    const u = D.upd.find(y => y.after === x || y.before === x); if (!u) return false;
    const a = u.before.row, b = u.after.row;
    return a.name === b.name && a.status === b.status && a.id === b.id;
  }
  function storedPositions(R) {
    const sp = {};
    for (const t in TABLES) if (TABLES[t].ided || t === 'schedule_versions') { const m = new Map(); for (const r of R[t] || []) m.set(pkOf(t, r), r.pos); sp[t] = m; }
    return sp;
  }

  // إصدار جدول محمّل وحده (تحميل خفيف) يحتفظ بموضعه المحفوظ
  function fixSchedulePos(rows, sp) {
    for (const x of rows) if (x.t === 'schedule_versions' && x.row.pos === -1) { const p = sp.schedule_versions.get(pkOf(x.t, x.row)); if (p !== undefined) x.row.pos = p; }
  }
  // يحمل البيانات حسب الخطة ويعيد: نص البيانات للخادم، ودالة الحفظ
  async function open(sql, plan) {
    const { R, loaded, readonly, heavy, light } = await loadRows(sql, plan);
    const db = fromRows(R, light);
    const beforeRows = toRows(db);
    // ضمان أن التحويل لا يغيّر شيئًا قبل أي عملية: ما قُرئ يطابق ما سيُكتب لو لم يتغير شيء
    const sp = storedPositions(R);
    for (const x of beforeRows) if (TABLES[x.t].ided) { const p = sp[x.t].get(pkOf(x.t, x.row)); if (p !== undefined) x.row.pos = p; }
    fixSchedulePos(beforeRows, sp);
    return {
      raw: JSON.stringify(db), db, heavy, loaded, readonly,
      async save(nextRaw, who) {
        const next = JSON.parse(nextRaw);
        const afterRows = toRows(next);
        await assignPositions(sql, afterRows, sp);
        fixSchedulePos(afterRows, sp);
        const D = diff(beforeRows, afterRows, loaded, readonly, sp);
        // انتماء كل قسم لمدرسته: قبل التعديل وبعده (نقل قسم إلى مدرسة أخرى يُرفض لغير المدير)
        const deptSchool = new Map();
        for (const x of afterRows) if (x.t === 'departments') deptSchool.set(x.row.id, x.row.school_id || null);
        if (who && who.role === 'school') for (const x of beforeRows) if (x.t === 'departments' && (x.row.school_id || null) !== who.schoolId) deptSchool.set('before:' + x.row.id, 'other');
        guard(D, who, deptSchool);
        if (!D.ins.length && !D.upd.length && !D.del.length) return { changed: 0 };
        await applyDiff(sql, D);
        await verifyWrite(sql, D);
        await Q(sql, `update ${SCHEMA}.meta set rev = rev + 1, updated_at = now() where id = 1`);
        return { changed: D.ins.length + D.upd.length + D.del.length, ins: D.ins.length, upd: D.upd.length, del: D.del.length };
      }
    };
  }

  // خطة التحميل لكل عملية
  function planFor(op, args, ctx, light, today) {
    const P = { heavy: new Set(), allHeavy: false, auditAll: false, daysFrom: null, ttSchools: new Set() };
    args = args || {};
    // ودجت شاشة القفل بكود شخصي (بلا جلسة): قسم صاحب الكود ومدرسته فقط لحساب تكليفاته
    if (op === 'widget.bell' && !ctx) {
      const k = typeof args.k === 'string' ? args.k : null;
      const acc = k ? (light.accounts || []).find(x => x && x.widgetKey === k && x.status === 'active') : null;
      if (acc && acc.deptId) { P.heavy.add(acc.deptId); const dep = light.departments.find(x => x.id === acc.deptId); if (dep && dep.schoolId) P.aaSchools = new Set([dep.schoolId]); }
      return P;
    }
    if (!ctx) return P;
    // تفضيلات الواجهة: سطر الحساب فقط (التحميل الخفيف)
    if (op === 'me.prefs' || op === 'me.homeSave') return P;
    // بطاقات الواجهة الرئيسية: قسم سجل صاحب الحساب، والقسم المعروض ضمن نطاقه (الإدارة ومدير النظام)، وتكليفات الإدارة لمدرسته
    if (op === 'home.data') {
      const sids = new Set(); let own = null;
      if (ctx.role === 'admin') { const t = light.admin && light.admin.teacherId ? light.teachers.find(x => x.id === light.admin.teacherId) : null; own = t ? light.departments.find(d => d.id === t.deptId) : null; }
      else if (ctx.deptId) own = light.departments.find(d => d.id === ctx.deptId);
      if (own) { P.heavy.add(own.id); if (own.schoolId) sids.add(own.schoolId); }
      if (ctx.role === 'school') sids.add(ctx.schoolId);
      if (typeof args.deptId === 'string') { const dep = light.departments.find(d => d.id === args.deptId); if (dep && (ctx.role === 'admin' || (ctx.role === 'school' && dep.schoolId === ctx.schoolId))) { P.heavy.add(dep.id); if (dep.schoolId) sids.add(dep.schoolId); } }
      else if (ctx.role === 'school') { const first = light.departments.find(d => d.schoolId === ctx.schoolId && d.status !== 'inactive'); if (first) P.heavy.add(first.id); }
      P.aaSchools = sids;
      return P;
    }
    // جدول المدرسة: بيانات المدرسة المطلوبة (يتحقق الخادم من الصلاحية)، وكل أقسامها عند التفعيل والإعداد وتحديث المعلمين
    // حالة جدول المدرسة لقسم: مدرسة القسم (يتحقق الخادم من الوصول للقسم)
    if (op === 'timetable.deptStatus') {
      const id = typeof args.deptId === 'string' ? args.deptId : ctx.deptId;
      const dep = light.departments.find(d => d.id === id);
      if (dep && dep.schoolId) P.ttSchools.add(dep.schoolId);
      return P;
    }
    if (/^timetable\./.test(op)) {
      let sid = ctx.role === 'school' ? ctx.schoolId : typeof args.schoolId === 'string' ? args.schoolId : null;
      if (!sid && ctx.role === 'head') { const g = (ctx.grants || []).find(x => x.allDepts); sid = g ? g.schoolId : null; }
      if (sid && light.schools.some(x => x.id === sid)) {
        P.ttSchools.add(sid);
        if (['timetable.activate', 'timetable.activatePreview', 'timetable.setup', 'timetable.rosterApply', 'timetable.importReady', 'timetable.importUndo', 'timetable.importContext'].includes(op)) for (const d of light.departments) if (d.schoolId === sid) P.heavy.add(d.id);
      }
      return P;
    }
    // توزيع الحصص المحالة للإدارة والإشعارات: تكليفات المدرسة، وكل أقسامها للتوزيع (حالاتها وجداولها وأيامها)
    if (/^(adminDist|notice)\./.test(op)) {
      const sids = new Set(); const ownSchool = () => { const own = light.departments.find(d => d.id === ctx.deptId); if (own && own.schoolId) sids.add(own.schoolId); };
      if (ctx.role === 'admin') {
        if (typeof args.schoolId === 'string') sids.add(args.schoolId);
        else if (typeof args.ref === 'string') { const dep = light.departments.find(d => d.id === args.ref.split('\u00a7')[0]); if (dep && dep.schoolId) sids.add(dep.schoolId); }
        else for (const x of light.schools) sids.add(x.id);
      } else if (ctx.role === 'school') sids.add(ctx.schoolId);
      else if (ctx.role === 'head') { for (const g of ctx.grants || []) if (g.perms && g.perms.has && g.perms.has('adminDist')) sids.add(g.schoolId); ownSchool(); }
      else ownSchool();
      P.aaSchools = sids;
      if (/^adminDist\./.test(op)) for (const d of light.departments) if (d.schoolId && sids.has(d.schoolId)) P.heavy.add(d.id);
      return P;
    }
    // جدولي وجدول القسم وطلبات التبديل: مدرسة الحساب (وتفويضات إدارة الطلبات)، وكل أقسامها لفحص التوفر عبر الأقسام
    if (/^(swap|my|bell|duty|sup)\./.test(op)) {
      const sids = new Set();
      const own = ctx.deptId ? light.departments.find(d => d.id === ctx.deptId) : null;
      // مدير النظام المربوط بسجل معلم: قسم سجله ومدرسته لتكليفاته في «توقيت اليوم»
      const adminT = ctx.role === 'admin' && op === 'bell.today' && light.admin && light.admin.teacherId ? light.teachers.find(t => t.id === light.admin.teacherId) : null;
      if (adminT) { const ad = light.departments.find(x => x.id === adminT.deptId); if (ad) { P.heavy.add(ad.id); if (ad.schoolId && (typeof args.schoolId !== 'string' || args.schoolId === ad.schoolId)) sids.add(ad.schoolId); } }
      if (ctx.role === 'admin') { if (typeof args.schoolId === 'string') sids.add(args.schoolId); }
      else if (ctx.role === 'school') sids.add(ctx.schoolId);
      else { if (own && own.schoolId) sids.add(own.schoolId); for (const g of ctx.grants || []) if (g.perms && g.perms.has && ['swapManage', 'bellManage', 'dutyManage', 'supManage'].some(k => g.perms.has(k))) sids.add(g.schoolId); }
      P.aaSchools = sids;
      if (/^(my|bell)\./.test(op)) { if (own) P.heavy.add(own.id); }
      else if (/^duty\./.test(op) || (/^sup\./.test(op) && op !== 'sup.get')) { /* أسماء المعلمين من التحميل الخفيف تكفي */ }
      else for (const d of light.departments) if (d.schoolId && sids.has(d.schoolId)) P.heavy.add(d.id);
      return P;
    }
    // بلاغ الحضور: قسم سجل صاحب الحساب (أو القسم المطلوب لعرض الحالات ضمن الصلاحية) ومدرسته، وتاريخ العرض
    if (/^att\./.test(op)) {
      let depId = null;
      const gd = new Set(); for (const g of ctx.grants || []) for (const id of g.deptIds || []) gd.add(id);
      if ((op === 'att.list' || op === 'att.setFor') && typeof args.deptId === 'string') {
        const dep = light.departments.find(d => d.id === args.deptId);
        if (dep && (ctx.role === 'admin' || (ctx.role === 'school' && dep.schoolId === ctx.schoolId) || (ctx.role === 'head' && (dep.id === ctx.deptId || gd.has(dep.id))))) depId = dep.id;
      } else if (ctx.role === 'admin') { const t = light.admin && light.admin.teacherId ? light.teachers.find(x => x.id === light.admin.teacherId) : null; depId = t ? t.deptId : null; }
      else depId = ctx.deptId || null;
      const dep = depId ? light.departments.find(d => d.id === depId) : null;
      if (dep) { P.heavy.add(dep.id); if (dep.schoolId) P.aaSchools = new Set([dep.schoolId]); }
      if (op === 'att.list' && typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date)) P.attDates = [args.date];
      return P;
    }
    // حساب المعلم: قسمه فقط (جدوله وأيامه المعتمدة)
    if (ctx.role === 'teacher') { if (ctx.deptId) P.heavy.add(ctx.deptId); return P; }
    if (ctx.role === 'head') {
      if (ctx.deptId) P.heavy.add(ctx.deptId);
      // المفوَّض: أقسام تفويضاته السارية فقط (يتحقق الخادم من العملية والقسم)
      const gd = new Set(); for (const g of ctx.grants || []) for (const id of g.deptIds) gd.add(id);
      if (typeof args.deptId === 'string' && gd.has(args.deptId)) P.heavy.add(args.deptId);
      if (typeof args.teacherId === 'string') { const t = light.teachers.find(x => x.id === args.teacherId); if (t && gd.has(t.deptId)) P.heavy.add(t.deptId); }
      if (/^school\./.test(op)) for (const id of gd) P.heavy.add(id);
      return P;
    }
    const has = id => typeof id === 'string' && light.departments.some(d => d.id === id);
    if (ctx.role === 'school') {
      const mine = light.departments.filter(d => d.schoolId === ctx.schoolId).map(d => d.id);
      if (has(args.deptId) && mine.includes(args.deptId)) P.heavy.add(args.deptId);
      if (typeof args.teacherId === 'string') { const t = light.teachers.find(x => x.id === args.teacherId); if (t && mine.includes(t.deptId)) P.heavy.add(t.deptId); }
      if (/^school(Import)?\./.test(op) || (op === 'audit.list' && !args.deptId)) for (const id of mine) P.heavy.add(id);
      if (op === 'audit.list' && !args.deptId) P.auditAll = true;
      return P;
    }
    if (has(args.deptId)) P.heavy.add(args.deptId);
    if (typeof args.teacherId === 'string') { const t = light.teachers.find(x => x.id === args.teacherId); if (t) P.heavy.add(t.deptId); }
    if (op === 'admin.dashboard') P.daysFrom = today;
    if (/^school(Import)?\./.test(op) && typeof args.schoolId === 'string') for (const d of light.departments) if (d.schoolId === args.schoolId) P.heavy.add(d.id);
    if (op === 'audit.list' && !args.deptId) P.auditAll = true;
    if (op === 'demo.remove' || op === 'system.wipe' || op === 'migration.export') P.allHeavy = true;
    return P;
  }

  // تحميل كامل لكل البيانات (للنسخ الاحتياطي والاختبارات)
  async function loadAll(sql) { const { R } = await loadRows(sql, { heavy: new Set(), allHeavy: true }); return fromRows(R); }
  // بدء نظيف: يكتب بيانات كاملة في قاعدة فارغة (للاختبارات ونقل نسخة كاملة)
  async function writeAll(sql, db) {
    const h = await open(sql, { heavy: new Set(), allHeavy: true });
    return h.save(JSON.stringify(db), null);
  }

  // استبدال كل البيانات (للاختبارات فقط): تفريغ الجداول ثم كتابة نسخة كاملة
  async function replaceAll(sql, db) {
    await Q(sql, `truncate ${Object.keys(TABLES).filter(t => t !== 'meta').map(t => SCHEMA + '.' + t).join(', ')} cascade`);
    await Q(sql, `update ${SCHEMA}.meta set schema_version = 10, system_name = null, created_at = null, extra = '{"k":[]}' where id = 1`);
    return writeAll(sql, db);
  }
  const PgStore = { open, planFor, loadAll, writeAll, replaceAll, toRows, fromRows, TABLES };
  if (typeof module !== 'undefined' && module.exports) module.exports = PgStore;
  root.PgStore = PgStore;
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* إرسال إشعارات الجهاز (Web Push) من الخادم دون مكتبات خارجية — WebCrypto فقط (Deno وNode).
 * - التشفير: RFC 8291 (aes128gcm، RFC 8188) بمفتاح المتصفح العام (p256dh) وسرّه (auth).
 * - التعريف بالخادم: VAPID (RFC 8292) بتوقيع ES256؛ المفتاح الخاص في قاعدة البيانات فقط ولا يصل للواجهة.
 * - لا يُرسل إلا إلى خدمات الدفع المعروفة للمتصفحات (منع إرسال الطلبات لعناوين عشوائية).
 * قبول خدمة الدفع للرسالة (201) لا يعني وصولها إلى الجهاز أو قراءتها.
 */
(function (root) {
  'use strict';
  const subtle = root.crypto.subtle;
  const te = new TextEncoder();
  const b64u = bytes => { let s = ''; const b = new Uint8Array(bytes); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const unb64u = str => { const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/'); const p = s + '==='.slice((s.length + 3) % 4); const bin = atob(p); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
  const cat = (...parts) => { const n = parts.reduce((s, p) => s + p.length, 0); const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
  async function hmac(key, data) { const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return new Uint8Array(await subtle.sign('HMAC', k, data)); }

  // خدمات الدفع المسموح بها (المتصفحات الرئيسية). PUSH_TEST_HOSTS للاختبار المحلي فقط.
  const HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^(.+\.)?push\.apple\.com$/, /^(.+\.)?push\.services\.mozilla\.com$/, /^(.+\.)?notify\.windows\.com$/];
  let testHosts = [];
  const setTestHosts = list => { testHosts = (list || []).map(String); };
  function endpointOk(ep) {
    let u; try { u = new URL(String(ep || '')); } catch (e) { return false; }
    if (testHosts.includes(u.host)) return true;
    return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && HOSTS.some(re => re.test(u.hostname));
  }

  // ---------- مفاتيح VAPID ----------
  async function generateVapid() {
    const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await subtle.exportKey('jwk', kp.privateKey);
    const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
    return { publicKey: b64u(pub), privateJwk: { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y } };
  }
  async function vapidHeader(endpoint, keys, subject, nowMs) {
    const aud = new URL(endpoint).origin;
    const exp = Math.floor((nowMs || Date.now()) / 1000) + 12 * 3600;
    const head = b64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const body = b64u(te.encode(JSON.stringify({ aud, exp, sub: subject })));
    const k = await subtle.importKey('jwk', { ...keys.privateJwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k, te.encode(head + '.' + body)));
    return `vapid t=${head}.${body}.${b64u(sig)}, k=${keys.publicKey}`;
  }

  // ---------- التشفير (RFC 8291) ----------
  async function encrypt(payload, p256dh, auth, opt) {
    opt = opt || {};
    const ua = unb64u(p256dh), secret = unb64u(auth);
    if (ua.length !== 65 || ua[0] !== 4) throw new Error('مفتاح الجهاز غير صالح');
    if (secret.length !== 16) throw new Error('سر الجهاز غير صالح');
    let asPub, asPriv;
    if (opt.asKeys) { // للاختبار بالمتجهات المرجعية فقط
      asPub = unb64u(opt.asKeys.publicKey);
      asPriv = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: opt.asKeys.d, x: b64u(asPub.slice(1, 33)), y: b64u(asPub.slice(33, 65)), ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    } else {
      const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      asPub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey)); asPriv = kp.privateKey;
    }
    const uaKey = await subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPriv, 256));
    const prkKey = await hmac(secret, ecdh);
    const ikm = await hmac(prkKey, cat(te.encode('WebPush: info\0'), ua, asPub, new Uint8Array([1])));
    const salt = opt.salt ? unb64u(opt.salt) : root.crypto.getRandomValues(new Uint8Array(16));
    const prk = await hmac(salt, ikm);
    const cek = (await hmac(prk, cat(te.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
    const nonce = (await hmac(prk, cat(te.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
    const data = typeof payload === 'string' ? te.encode(payload) : new Uint8Array(payload);
    if (data.length > 3800) throw new Error('محتوى الإشعار أكبر من المسموح');
    const key = await subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(data, new Uint8Array([2]))));
    const rs = new Uint8Array([0, 0, 0x10, 0]); // 4096
    return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
  }
  // فك التشفير (للاختبار المحلي بخدمة دفع وهمية فقط)
  async function decrypt(body, uaPrivJwk, uaPubB64, authB64) {
    const b = new Uint8Array(body); const salt = b.slice(0, 16); const idlen = b[20]; const asPub = b.slice(21, 21 + idlen); const ct = b.slice(21 + idlen);
    const ua = unb64u(uaPubB64), secret = unb64u(authB64);
    const priv = await subtle.importKey('jwk', { ...uaPrivJwk, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const asKey = await subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, priv, 256));
    const prkKey = await hmac(secret, ecdh);
    const ikm = await hmac(prkKey, cat(te.encode('WebPush: info\0'), ua, asPub, new Uint8Array([1])));
    const prk = await hmac(salt, ikm);
    const cek = (await hmac(prk, cat(te.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
    const nonce = (await hmac(prk, cat(te.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
    const key = await subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
    const pt = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
    let end = pt.length - 1; while (end >= 0 && pt[end] === 0) end--;
    if (pt[end] !== 2) throw new Error('bad padding');
    return new TextDecoder().decode(pt.slice(0, end));
  }

  /* إرسال رسالة واحدة. النتيجة: accepted (قبلتها خدمة الدفع) / gone (الاشتراك انتهى: يُحذف) / retry (مؤقت) / failed */
  async function send(sub, message, keys, opt) {
    opt = opt || {};
    if (!endpointOk(sub.endpoint)) return { result: 'failed', status: null, error: 'عنوان خدمة الدفع غير مسموح' };
    let body, auth;
    try { body = await encrypt(JSON.stringify(message), sub.p256dh, sub.auth); auth = await vapidHeader(sub.endpoint, keys, opt.subject, opt.nowMs); }
    catch (e) { return { result: 'failed', status: null, error: String(e && e.message || e).slice(0, 200) }; }
    let r;
    try {
      r = await (opt.fetch || root.fetch)(sub.endpoint, { method: 'POST', headers: { authorization: auth, 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: String(opt.ttl || 86400), urgency: opt.urgency || 'high', ...(opt.topic ? { topic: opt.topic } : {}) }, body });
    } catch (e) { return { result: 'retry', status: null, error: 'تعذّر الاتصال بخدمة الدفع' }; }
    let text = ''; try { text = (await r.text()).slice(0, 200); } catch (e) { text = ''; }
    if (r.status === 201 || r.status === 200 || r.status === 202) return { result: 'accepted', status: r.status };
    if (r.status === 404 || r.status === 410) return { result: 'gone', status: r.status, error: 'انتهى اشتراك الجهاز لدى خدمة الدفع' };
    if (r.status === 429 || r.status >= 500) return { result: 'retry', status: r.status, error: text || 'خدمة الدفع مشغولة' };
    return { result: 'failed', status: r.status, error: text || ('HTTP ' + r.status) };
  }

  const WebPush = { generateVapid, vapidHeader, encrypt, decrypt, send, endpointOk, setTestHosts, b64u, unb64u };
  if (typeof module !== 'undefined' && module.exports) module.exports = WebPush;
  root.WebPush = WebPush;
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* حفظ الإشعارات واشتراكات الأجهزة وسجل الإرسال في PostgreSQL (خارج بيانات النظام الرئيسية):
 *  - ihtiyat.notifications: إشعار لكل حساب (يُحفظ نصه كما أُنشئ؛ تغيير القوالب لاحقًا لا يغيّره). مفتاح منع التكرار لكل حساب.
 *  - ihtiyat.push_subs: اشتراك كل جهاز مربوط بحساب واحد وبالجلسة التي فعّلته؛ تسجيل الخروج يفصله.
 *  - ihtiyat.push_log: محاولة إرسال لكل (إشعار، جهاز): بانتظار / قيد الإرسال / قبلته خدمة الدفع / فشل / انتهى الاشتراك.
 *  - ihtiyat.notify_state: مفاتيح VAPID (الخاص لا يغادر الخادم)، وسر نبضة الجدولة، وآخر نبضة.
 * قبول خدمة الدفع للرسالة لا يعني وصولها للجهاز؛ فشل الإرسال للجهاز لا يمس التكليف ولا إشعاره داخل الموقع.
 */
(function (root) {
  'use strict';
  const WebPush = root.WebPush || (typeof require !== 'undefined' ? require('./webpush.js') : null);
  const S = 'ihtiyat';
  const subtle = root.crypto.subtle;
  const hex = b => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
  const sha256 = async s => hex(await subtle.digest('SHA-256', new TextEncoder().encode(String(s))));
  const MAX_ATTEMPTS = 4;
  const ROLE_AR = { organizer: 'مدير النظام', principal: 'مدير المدرسة', assistant: 'مساعد المدير', head: 'رئيس قسم', deputy: 'نائب رئيس القسم', teacher: 'معلم' };

  // الجلسة: بصمة الرمز في جدول الجلسات، والحساب فعّال (مدير النظام دائمًا)
  async function sessionOf(sql, token) {
    if (!token) return null;
    const h = await sha256(token);
    const r = await sql`select s.user_id, u.role, u.status from ${sql(S)}.sessions s join ${sql(S)}.users u on u.id = s.user_id where s.token_hash = ${h} and s.expires_at > now()`;
    if (!r.length) return null;
    const x = r[0];
    if (x.role !== 'organizer' && x.status !== 'active') return null;
    return { accountId: x.user_id, role: x.role, sessionHash: h };
  }

  // إدراج الإشعارات (داخل معاملة الحدث) وتجهيز محاولات الإرسال لأجهزة المستلمين. يعيد معرّفات المحاولات.
  async function insertItems(tx, items) {
    const pushIds = [];
    for (let i = 0; i < items.length; i += 200) {
      const part = items.slice(i, i + 200).map(x => ({ account_id: x.accountId, school_id: x.schoolId || null, kind: x.kind, dedupe_key: String(x.key).slice(0, 400), title: x.title, body: x.body, link: x.link || null, inapp: x.inapp !== false, push: !!x.push }));
      const rows = await tx`insert into ${tx(S)}.notifications ${tx(part, 'account_id', 'school_id', 'kind', 'dedupe_key', 'title', 'body', 'link', 'inapp', 'push')} on conflict (account_id, dedupe_key) do nothing returning id, account_id, push`;
      const ids = rows.filter(r => r.push).map(r => Number(r.id));
      if (ids.length) {
        const q = await tx`insert into ${tx(S)}.push_log (notification_id, sub_id, account_id, host, status)
          select n.id, s.id, s.account_id, split_part(split_part(s.endpoint, '://', 2), '/', 1), 'pending'
          from ${tx(S)}.notifications n join ${tx(S)}.push_subs s on s.account_id = n.account_id where n.id = any(${ids})
          on conflict (notification_id, sub_id) do nothing returning id`;
        for (const r of q) pushIds.push(Number(r.id));
      }
    }
    return pushIds;
  }

  // ---------- داخل الموقع ----------
  async function list(sql, acc, a) {
    const limit = Math.min(100, Math.max(1, Number(a && a.limit) || 30));
    const before = a && Number.isInteger(Number(a.before)) && Number(a.before) > 0 ? Number(a.before) : null;
    const onlyUnread = !!(a && a.unread);
    const rows = await sql`select id, kind, title, body, link, created_at, read_at from ${sql(S)}.notifications
      where account_id = ${acc} and inapp ${before ? sql`and id < ${before}` : sql``} ${onlyUnread ? sql`and read_at is null` : sql``}
      order by id desc limit ${limit + 1}`;
    const unread = (await sql`select count(*)::int as n from ${sql(S)}.notifications where account_id = ${acc} and inapp and read_at is null`)[0].n;
    return { items: rows.slice(0, limit).map(r => ({ id: Number(r.id), kind: r.kind, title: r.title, body: r.body, link: r.link, at: new Date(r.created_at).toISOString(), read: !!r.read_at })), more: rows.length > limit, unread };
  }
  async function count(sql, acc) { return { unread: (await sql`select count(*)::int as n from ${sql(S)}.notifications where account_id = ${acc} and inapp and read_at is null`)[0].n }; }
  async function markRead(sql, acc, a) {
    if (a && a.all === true) { const r = await sql`update ${sql(S)}.notifications set read_at = now() where account_id = ${acc} and inapp and read_at is null returning id`; return { marked: r.length }; }
    const ids = (Array.isArray(a && a.ids) ? a.ids : []).map(Number).filter(Number.isInteger).slice(0, 200);
    if (!ids.length) return { marked: 0 };
    const r = await sql`update ${sql(S)}.notifications set read_at = now() where account_id = ${acc} and id = any(${ids}) and read_at is null returning id`;
    return { marked: r.length };
  }

  // ---------- مفاتيح VAPID ----------
  async function vapid(sql) {
    let r = (await sql`select vapid_public, vapid_private from ${sql(S)}.notify_state where id = 1`)[0];
    if (!r) throw new Error('notify_state missing');
    if (!r.vapid_public) {
      const k = await WebPush.generateVapid();
      await sql`update ${sql(S)}.notify_state set vapid_public = ${k.publicKey}, vapid_private = ${sql.json(k.privateJwk)} where id = 1 and vapid_public is null`;
      r = (await sql`select vapid_public, vapid_private from ${sql(S)}.notify_state where id = 1`)[0];
    }
    const priv = typeof r.vapid_private === 'string' ? JSON.parse(r.vapid_private) : r.vapid_private;
    return { publicKey: r.vapid_public, privateJwk: priv };
  }

  // ---------- أجهزة الحساب ----------
  const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').slice(0, n);
  async function subscribe(sql, ses, a) {
    const ep = String(a && a.endpoint || ''); const k = (a && a.keys) || {};
    if (ep.length > 1000 || !WebPush.endpointOk(ep)) return { ok: false, error: 'عنوان خدمة الإشعارات غير مدعوم.' };
    let p, au; try { p = WebPush.unb64u(k.p256dh); au = WebPush.unb64u(k.auth); } catch (e) { p = null; }
    if (!p || p.length !== 65 || !au || au.length !== 16) return { ok: false, error: 'بيانات اشتراك الجهاز غير صالحة.' };
    const device = clean(a.device, 80) || 'جهاز';
    const r = await sql`insert into ${sql(S)}.push_subs (endpoint, p256dh, auth, account_id, session_hash, device)
      values (${ep}, ${k.p256dh}, ${k.auth}, ${ses.accountId}, ${ses.sessionHash}, ${device})
      on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, account_id = excluded.account_id, session_hash = excluded.session_hash, device = excluded.device, fails = 0, last_error = null, created_at = case when ${sql(S)}.push_subs.account_id = excluded.account_id then ${sql(S)}.push_subs.created_at else now() end
      returning id`;
    return { ok: true, id: Number(r[0].id) };
  }
  // بعد الدخول أو فتح صفحة الحساب: اشتراك هذا المتصفح لمن؟ لحساب آخر = يُفصل فورًا (جهاز مشترك)
  async function sync(sql, ses, a) {
    const ep = String(a && a.endpoint || '');
    if (!ep) return { state: 'none' };
    const r = await sql`select id, account_id from ${sql(S)}.push_subs where endpoint = ${ep}`;
    if (!r.length) return { state: 'none' };
    if (r[0].account_id === ses.accountId) { await sql`update ${sql(S)}.push_subs set session_hash = ${ses.sessionHash} where id = ${r[0].id}`; return { state: 'active', id: Number(r[0].id) }; }
    await sql`delete from ${sql(S)}.push_subs where id = ${r[0].id}`;
    return { state: 'detached' };
  }
  async function unsubscribe(sql, ses, a) {
    const ep = a && a.endpoint ? String(a.endpoint) : null; const id = a && Number.isInteger(Number(a.id)) ? Number(a.id) : null;
    const r = ep ? await sql`delete from ${sql(S)}.push_subs where endpoint = ${ep} and account_id = ${ses.accountId} returning id`
      : id ? await sql`delete from ${sql(S)}.push_subs where id = ${id} and account_id = ${ses.accountId} returning id` : [];
    return { removed: r.length };
  }
  async function devices(sql, acc) {
    const r = await sql`select id, device, created_at, last_ok_at, last_error, fails, split_part(split_part(endpoint, '://', 2), '/', 1) as host from ${sql(S)}.push_subs where account_id = ${acc} order by id`;
    return r.map(x => ({ id: Number(x.id), device: x.device, host: x.host, since: new Date(x.created_at).toISOString(), lastOk: x.last_ok_at ? new Date(x.last_ok_at).toISOString() : null, lastError: x.last_error, fails: x.fails }));
  }
  // تسجيل الخروج: تُفصل اشتراكات الأجهزة التي فعّلتها هذه الجلسة
  async function detachSession(sql, token) { if (!token) return 0; const h = await sha256(token); const r = await sql`delete from ${sql(S)}.push_subs where session_hash = ${h} returning id`; return r.length; }

  /* الإرسال: يحجز المحاولات المنتظرة (لا يرسلها طلبان معًا)، ويرسل كل واحدة، ويسجّل الرد.
     المحاولة العالقة «قيد الإرسال» أكثر من 5 دقائق تُسجّل «غير معروفة» ولا تُعاد (لا تكرار محتمل). */
  async function dispatch(sql, ids, opt) {
    opt = opt || {};
    await sql`update ${sql(S)}.push_log set status = 'failed', error = 'انقطع الإرسال قبل معرفة النتيجة (غير معروف إن كانت خدمة الدفع قبلته)', updated_at = now() where status = 'sending' and updated_at < now() - interval '5 minutes'`;
    const only = Array.isArray(ids) ? ids.map(Number).filter(Number.isInteger) : null;
    if (only && !only.length) return [];
    const claimed = await sql`update ${sql(S)}.push_log set status = 'sending', attempts = attempts + 1, updated_at = now() where id in (
        select id from ${sql(S)}.push_log where status = 'pending' and created_at > now() - interval '24 hours' ${only ? sql`and id = any(${only})` : sql``} order by id limit ${opt.limit || 300} for update skip locked)
      returning id, notification_id, sub_id, attempts`;
    if (!claimed.length) return [];
    const keys = await vapid(sql);
    const nIds = Array.from(new Set(claimed.map(x => Number(x.notification_id))));
    const sIds = Array.from(new Set(claimed.map(x => x.sub_id).filter(x => x != null).map(Number)));
    const N = new Map((await sql`select id, title, body, link, kind from ${sql(S)}.notifications where id = any(${nIds})`).map(r => [Number(r.id), r]));
    const SU = new Map((sIds.length ? await sql`select id, endpoint, p256dh, auth from ${sql(S)}.push_subs where id = any(${sIds})` : []).map(r => [Number(r.id), r]));
    const out = [];
    await Promise.all(claimed.map(async c => {
      const n = N.get(Number(c.notification_id)); const sub = c.sub_id != null ? SU.get(Number(c.sub_id)) : null;
      let res;
      if (!n || !sub) res = { result: 'gone', status: null, error: 'الجهاز لم يعد مشتركًا' };
      else res = await WebPush.send(sub, { title: n.title, body: n.body, url: '/?n=' + n.id + (n.link || '#/notifs'), tag: 'n' + n.id, id: Number(n.id) }, keys, { subject: opt.subject, fetch: opt.fetch, ttl: 86400, urgency: 'high' });
      let status = res.result;
      if (status === 'retry') status = c.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      await sql`update ${sql(S)}.push_log set status = ${status}, http_status = ${res.status == null ? null : res.status}, error = ${res.error ? String(res.error).slice(0, 300) : null}, updated_at = now() where id = ${c.id}`;
      if (sub) {
        if (res.result === 'accepted') await sql`update ${sql(S)}.push_subs set last_ok_at = now(), fails = 0, last_error = null where id = ${sub.id}`;
        else if (res.result === 'gone') await sql`delete from ${sql(S)}.push_subs where id = ${sub.id}`;
        else await sql`update ${sql(S)}.push_subs set fails = fails + 1, last_error = ${String(res.error || '').slice(0, 200)} where id = ${sub.id}`;
      }
      out.push({ id: Number(c.id), notificationId: Number(c.notification_id), result: status, http: res.status });
    }));
    return out;
  }

  // ---------- مدير النظام: سجل الإرسال ----------
  async function log(sql, a) {
    a = a || {};
    const limit = Math.min(300, Math.max(1, Number(a.limit) || 100));
    const sid = typeof a.schoolId === 'string' && a.schoolId ? a.schoolId : null;
    const kind = typeof a.kind === 'string' && a.kind ? a.kind : null;
    const rows = await sql`select n.id, n.kind, n.title, n.created_at, n.read_at, n.inapp, n.push, n.school_id, n.account_id, u.name as account_name, u.role,
        coalesce(json_agg(json_build_object('host', l.host, 'status', l.status, 'http', l.http_status, 'error', l.error, 'attempts', l.attempts, 'at', l.updated_at) order by l.id) filter (where l.id is not null), '[]') as sends
      from ${sql(S)}.notifications n left join ${sql(S)}.users u on u.id = n.account_id left join ${sql(S)}.push_log l on l.notification_id = n.id
      where true ${sid ? sql`and n.school_id = ${sid}` : sql``} ${kind ? sql`and n.kind = ${kind}` : sql``}
      group by n.id, u.name, u.role order by n.id desc limit ${limit}`;
    const st = (await sql`select status, count(*)::int as n from ${sql(S)}.push_log where created_at > now() - interval '7 days' group by status`);
    const tick = (await sql`select last_tick, tick_at, tick_note from ${sql(S)}.notify_state where id = 1`)[0] || {};
    const subs = (await sql`select count(*)::int as n from ${sql(S)}.push_subs`)[0].n;
    return {
      items: rows.map(r => ({ id: Number(r.id), kind: r.kind, title: r.title, at: new Date(r.created_at).toISOString(), read: !!r.read_at, inapp: r.inapp, push: r.push, schoolId: r.school_id,
        to: r.account_name || r.account_id, role: ROLE_AR[r.role] || '', sends: (typeof r.sends === 'string' ? JSON.parse(r.sends) : r.sends).map(x => ({ ...x, at: x.at ? new Date(x.at).toISOString() : null })) })),
      week: Object.fromEntries(st.map(x => [x.status, x.n])), devices: subs,
      tick: { last: tick.last_tick ? new Date(tick.last_tick).toISOString() : null, at: tick.tick_at ? new Date(tick.tick_at).toISOString() : null, note: tick.tick_note || null }
    };
  }

  // رسالة اختبار لحساب المدير نفسه وأجهزته فقط
  async function testSend(sql, ses, plan, opt) {
    const key = 'test:' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 8);
    const ids = await sql.begin(tx => insertItems(tx, [{ accountId: ses.accountId, schoolId: null, kind: 'test.' + plan.type, key, title: plan.title, body: plan.body, link: plan.link, inapp: true, push: true }]));
    const res = await dispatch(sql, ids, opt);
    const devs = await devices(sql, ses.accountId);
    return { inapp: true, devices: devs.length, results: res.map(r => ({ result: r.result, http: r.http })) };
  }

  /* نبضة الجدولة: نافذة من آخر نبضة حتى الآن (بحد أقصى 30 دقيقة، والأولى تبدأ من الآن فلا تذكير بمواعيد مضت)،
     ثم إرسال المحاولات المنتظرة. قفل استشاري يمنع نبضتين متزامنتين. */
  async function tick(sql, runReminders, opt) {
    opt = opt || {};
    const nowMs = opt.nowMs || Date.now();
    const got = await sql.begin(async tx => {
      const l = (await tx`select pg_try_advisory_xact_lock(74210511) as ok`)[0].ok;
      if (!l) return null;
      const st = (await tx`select last_tick from ${tx(S)}.notify_state where id = 1 for update`)[0];
      const last = st && st.last_tick ? new Date(st.last_tick).getTime() : nowMs;
      const from = Math.max(last, nowMs - 30 * 60000);
      await tx`update ${tx(S)}.notify_state set last_tick = ${new Date(nowMs)}, tick_at = now() where id = 1`;
      return { from };
    });
    if (!got) return { skipped: 'busy' };
    let rem = { items: 0, pushIds: [] }, note = null;
    try { if (got.from < nowMs) rem = await runReminders(got.from, nowMs); }
    catch (e) { note = 'تعذّر حساب التذكيرات: ' + String(e && e.message || e).slice(0, 200); }
    const sent = await dispatch(sql, null, opt);
    await sql`update ${sql(S)}.notify_state set tick_note = ${note || `تذكيرات: ${rem.items}، إرسال: ${sent.length}`} where id = 1`;
    return { from: new Date(got.from).toISOString(), to: new Date(nowMs).toISOString(), reminders: rem.items, sent: sent.length, note };
  }
  async function cronOk(sql, given) {
    if (!given || typeof given !== 'string' || given.length < 32) return false;
    const r = (await sql`select cron_secret from ${sql(S)}.notify_state where id = 1`)[0];
    if (!r) return false;
    const [a, b] = await Promise.all([sha256(given), sha256(r.cron_secret)]);
    let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
  }

  const NotifStore = { sessionOf, insertItems, list, count, markRead, vapid, subscribe, sync, unsubscribe, devices, detachSession, dispatch, log, testSend, tick, cronOk, sha256 };
  if (typeof module !== 'undefined' && module.exports) module.exports = NotifStore;
  root.NotifStore = NotifStore;
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* تشغيل عملية واحدة من خادم نظام الاحتياط على قاعدة PostgreSQL داخل معاملة واحدة:
 * قفل سطر الإصدار ← تحميل البيانات اللازمة ← تنفيذ العملية بالقواعد نفسها ← كتابة الفروق والتحقق منها ← إنهاء المعاملة.
 * أي خطأ أثناء الكتابة يلغي المعاملة كاملة، فلا يُحفظ جزء من العملية دون باقيها.
 */
(function (root) {
  'use strict';
  const Server = root.Server || (typeof require !== 'undefined' ? require('../../src/server.js') : null);
  const PgStore = root.PgStore || (typeof require !== 'undefined' ? require('./pgstore.js') : null);
  const NotifStore = root.NotifStore || (typeof require !== 'undefined' ? require('./notifstore.js') : null);

  const isPublic = op => typeof op === 'string' && op.startsWith('auth.');

  // عمليات قراءة فقط (لا تحفظ شيئًا): تعمل بقفل مشترك، فتُنفَّذ القراءات المتزامنة معًا بدل أن تنتظر كل واحدة الأخرى،
  // وتبقى الكتابة (قفل حصري) ممنوعة أثناءها فلا تُقرأ بيانات نصف مكتوبة.
  // إن أرادت عملية من هذه القائمة الحفظ لأي سبب، تُلغى محاولتها كاملة وتُعاد بقفل حصري — فلا تُكتب بيانات تحت قفل القراءة.
  const READ_OPS = new Set(['me.get', 'admin.dashboard', 'dept.list', 'dept.get', 'teacher.list', 'notify.dayPlan', 'schedule.get', 'importProfile.get',
    'state.get', 'day.get', 'day.preview', 'days.list', 'day.correctInfo', 'day.correctPreview', 'report.build', 'account.list', 'deputy.list', 'audit.list',
    'school.list', 'school.dashboard', 'school.adminSlots', 'school.report', 'schoolImport.context', 'delegation.list', 'timetable.get', 'timetable.activatePreview', 'timetable.importContext', 'teacher.myView', 'teacherAccounts.context', 'adminDist.list', 'adminDist.options', 'adminDist.autoPlan', 'notice.list', 'preview.options', 'timetable.deptStatus', 'my.schedule', 'my.deptSchedule', 'swap.options', 'swap.preview', 'swap.list', 'bell.get', 'bell.today', 'widget.bell', 'duty.list', 'auth.clock', 'sup.get', 'sup.rotPreview', 'taImport.context', 'taImport.preview', 'home.data', 'itt.get']);
  const NEEDS_WRITE = Symbol('needsWrite');

  async function attempt(sql, req, cfg, mode) {
    const { token, op, args, meta } = req;
    const now = cfg.now || (() => new Date());
    const serverOpts = { now, production: !!cfg.production, setupKey: cfg.setupKey || null, pbkdf2Iter: cfg.pbkdf2Iter };
    return sql.begin(async tx => {
      await tx.unsafe(`select rev from ihtiyat.meta where id = 1 ${mode === 'read' ? 'for share' : 'for update'}`);
      let who = { role: 'public' };
      const today = Server.kuwaitToday(now());
      const h = await PgStore.open(tx, async light => {
        const raw = JSON.stringify(light);
        const probe = Server.createServer({ ...serverOpts, storage: { load: () => raw, save() { } } });
        // معاينة مدير النظام: نطاق التحميل نطاق الحساب المعروض (الخادم يتحقق من أن الجلسة جلسة المدير قبل التنفيذ)
        const pv = meta && meta.as ? await probe.previewTargetOf(token, meta.as) : null;
        const ctx = pv || await probe.sessionOf(token);
        if (!isPublic(op) && ctx) who = ctx.role === 'admin' ? { role: 'admin' } : ctx.role === 'school' ? { role: 'school', id: ctx.id, schoolId: ctx.schoolId } : ctx.role === 'teacher' ? { role: 'teacher', id: ctx.id, deptId: ctx.deptId } : { role: 'head', id: ctx.id, deptId: ctx.deptId, taDepts: Array.from(new Set((ctx.kind === 'head' ? [ctx.deptId] : []).concat((ctx.grants || []).filter(g => [...g.perms].includes('teacherImport')).flatMap(g => g.deptIds)))), grantDepts: Array.from(new Set((ctx.grants || []).flatMap(g => g.deptIds))), ttSchools: Array.from(new Set((ctx.grants || []).filter(g => g.allDepts && [...g.perms].some(k => /^tt/.test(k))).map(g => g.schoolId))), adSchools: Array.from(new Set((ctx.grants || []).filter(g => [...g.perms].includes('adminDist')).map(g => g.schoolId))), swSchools: Array.from(new Set((ctx.grants || []).filter(g => [...g.perms].includes('swapManage')).map(g => g.schoolId))), blSchools: Array.from(new Set((ctx.grants || []).filter(g => [...g.perms].includes('bellManage') || [...g.perms].includes('dutyManage') || [...g.perms].includes('supManage')).map(g => g.schoolId))) };
        return PgStore.planFor(op, args, isPublic(op) ? null : ctx, light, today);
      });
      let saved = null;
      const server = Server.createServer({ ...serverOpts, storage: { load: () => (saved != null ? saved : h.raw), save: s => { saved = s; } } });
      let result, error = null;
      try { result = await server.call(token, op, args, meta); }
      catch (e) { error = e; }
      if (meta && meta.as) saved = null; // المعاينة لا تحفظ شيئًا أبدًا (والخادم ينفّذها على نسخة مؤقتة أصلًا)
      if (mode === 'read' && saved != null) throw NEEDS_WRITE; // تُلغى المعاملة وتُعاد بقفل حصري
      let write = null, pushIds = [];
      // ما اعتمده الخادم يُكتب حتى لو فشلت العملية بعده (مثل تسجيل محاولة دخول فاشلة)
      if (saved != null) write = await h.save(saved, who);
      // الإشعارات: بعد نجاح حفظ الحدث وداخل المعاملة نفسها (فشل الحفظ = لا إشعار، ولا إشعار من المعاينة)
      if (!error && write && write.changed && !(meta && meta.as) && NotifStore && server.notifyDerive) {
        const items = server.notifyDerive(h.raw, { id: who.role === 'admin' ? 'admin' : who.id || null, name: null });
        if (items.length) pushIds = await NotifStore.insertItems(tx, items);
      }
      if (cfg.beforeCommit && write && write.changed) await cfg.beforeCommit(tx);
      return { result, error, write, pushIds };
    });
  }

  async function runOp(sql, req, cfg) {
    // المعاينة لا تكتب، فتُنفَّذ دائمًا بقفل القراءة المشترك
    if ((READ_OPS.has(req.op) || (req.meta && req.meta.as)) && !cfg.forceWriteLock) {
      try { return await attempt(sql, req, cfg, 'read'); }
      catch (e) { if (e !== NEEDS_WRITE) throw e; }
    }
    return attempt(sql, req, cfg, 'write');
  }

  /* التذكيرات المستحقة في نافذة زمنية: قراءة فقط (الجداول الحالية وأيام اليوم وما بعده وتوقيت المدارس)، ثم إدراج الإشعارات.
     تُنفَّذ من نبضة الجدولة في الخلفية، فلا تحتاج بقاء أي صفحة مفتوحة. */
  /* الغياب التلقائي الساعة 8:00 (كتابة): الأقسام المفعّل لها «تسجيل حالة الحضور» فقط، بقفل الكتابة نفسه لأي عملية،
     ثم إشعار «تم تسجيلك غياب» لأصحاب السجلات داخل المعاملة نفسها. خارج نافذة 8:00 لا يُفتح أي قفل. */
  async function runAttAuto(sql, cfg, fromMs, toMs) {
    const date = Server.kuwaitToday(new Date(toMs)); const S = Date.parse(`${date}T08:00:00+03:00`);
    if (!(S > fromMs && S <= toMs)) return { count: 0, pushIds: [] };
    const now = cfg.now || (() => new Date());
    return sql.begin(async tx => {
      await tx.unsafe('select rev from ihtiyat.meta where id = 1 for update');
      const h = await PgStore.open(tx, async light => {
        const deps = light.departments.filter(x => x.attOn && x.attOn.on);
        const sids = new Set(deps.map(x => x.schoolId).filter(Boolean));
        return { heavy: new Set(deps.map(x => x.id)), allHeavy: false, auditAll: false, attDates: [date], ttSchools: sids, aaSchools: sids };
      });
      let saved = null;
      const server = Server.createServer({ now, production: !!cfg.production, setupKey: cfg.setupKey || null, storage: { load: () => (saved != null ? saved : h.raw), save: s => { saved = s; } } });
      const r = await server.notifyAttAuto(fromMs, toMs);
      let pushIds = [];
      if (saved != null && r.count) {
        const w = await h.save(saved, { role: 'admin' });
        if (w && w.changed) { const items = server.notifyDerive(h.raw, { id: null, name: 'النظام' }); if (items.length) pushIds = await NotifStore.insertItems(tx, items); }
      }
      return { count: r.count, pushIds };
    });
  }

  async function runReminders(sql, cfg, fromMs, toMs) {
    // الغياب التلقائي أولًا (معاملة مستقلة)؛ فشله لا يمنع التذكيرات ويظهر في ملاحظة النبضة
    let auto = { count: 0, pushIds: [] }, autoErr = null;
    try { auto = await runAttAuto(sql, cfg, fromMs, toMs); } catch (e) { autoErr = e; }
    const rem = await runRemindersOnly(sql, cfg, fromMs, toMs);
    if (autoErr) throw new Error('الغياب التلقائي: ' + String(autoErr && autoErr.message || autoErr));
    return { items: rem.items + auto.count, pushIds: rem.pushIds.concat(auto.pushIds), auto: auto.count };
  }
  async function runRemindersOnly(sql, cfg, fromMs, toMs) {
    const now = cfg.now || (() => new Date());
    const today = Server.kuwaitToday(new Date(toMs));
    return sql.begin(async tx => {
      await tx.unsafe('select rev from ihtiyat.meta where id = 1 for share');
      const h = await PgStore.open(tx, async light => ({ heavy: new Set(), allHeavy: false, auditAll: false, daysFrom: today, lightEntries: true, ttSchools: new Set(light.schools.map(x => x.id)), aaSchools: new Set(light.schools.map(x => x.id)) }));
      const server = Server.createServer({ now, production: !!cfg.production, setupKey: cfg.setupKey || null, storage: { load: () => h.raw, save() { throw new Error('read only'); } } });
      const items = server.notifyReminders(fromMs, toMs);
      const pushIds = items.length ? await NotifStore.insertItems(tx, items) : [];
      return { items: items.length, pushIds };
    });
  }

  const Runner = { runOp, runReminders, runAttAuto, isPublic, READ_OPS };
  if (typeof module !== 'undefined' && module.exports) module.exports = Runner;
  root.Runner = Runner;
})(typeof globalThis !== 'undefined' ? globalThis : this);
