import { appointments, auditEvents, containers, type GateAppointment } from './domain.js';
import {
  analyzeConflicts, coveredSlots, crossesMidnight, getReplanHistory, isActive,
  laneLabel, LANE_CAPACITY, LANES, LANE_CAPACITY as CAP, nextUtcMidnight,
  pushReplan, recordRelease, SLOT_MS, TURNAROUND_MINUTES,
  type AppointmentChange, type GateConflict, type Lane, type LaneLoad,
  type ReplanRecord, type SchedulePlan, type ScheduleSuggestion, type SuggestionKind, type WindowSpec,
} from './gateCore.js';

/** 闸口时隙编排：读取现有预约 → 按车牌/箱号/类型/车道容量/时间窗计算可行调整 →
 *  值班员确认后以“串行化 + 乐观版本 + 实时重校验”的方式原子落库，并保留前后差异。 */

export class ScheduleConflictError extends Error {
  code: 'STALE_SUGGESTION' | 'VERSION_CONFLICT' | 'ALREADY_APPLIED' | 'CHECKED_IN_LOCKED'
    | 'SLOT_TAKEN' | 'CUSTOMS_NOT_RELEASED' | 'APPOINTMENT_GONE' | 'NO_FEASIBLE_ADJUSTMENT';
  details?: Record<string, unknown>;
  constructor(code: ScheduleConflictError['code'], message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ScheduleConflictError';
    this.code = code;
    this.details = details;
  }
}

const now = () => Date.now();
const getAppt = (id: string) => appointments.find(a => a.id === id);
const specOf = (a: GateAppointment): WindowSpec => ({
  windowStart: a.windowStart, windowEnd: a.windowEnd, lane: a.lane,
  status: a.status, ...(a.exception === undefined ? {} : { exception: a.exception }),
});
const customsOf = (a: GateAppointment) => containers.find(c => c.id === a.containerId)?.customs;

/** 计划窗口默认覆盖当前时刻之后 6 小时（12 个 30 分钟时隙）。 */
export function buildSchedulePlan(windowMinutes = 360): SchedulePlan {
  const start = Math.floor(now() / SLOT_MS) * SLOT_MS;
  const end = start + windowMinutes * 60000;
  const bounds = { start, end };
  const conflicts = analyzeConflicts(appointments, containers, bounds);

  const laneLoads: LaneLoad[] = [];
  for (let slot = start; slot < end; slot += SLOT_MS) {
    const entry: LaneLoad = { slotStart: new Date(slot).toISOString(), lanes: { north: loadOf('north', slot), south: loadOf('south', slot), rail: loadOf('rail', slot) } };
    laneLoads.push(entry);
  }
  function loadOf(lane: Lane, slot: number) {
    const load = appointments.filter(isActive).filter(a => a.lane === lane && coveredSlots(a.windowStart, a.windowEnd).includes(slot)).length;
    return { load, capacity: LANE_CAPACITY[lane] };
  }

  const suggestions: ScheduleSuggestion[] = [];
  const seenManual = new Set<string>();
  const pushManual = (targetId: string, ids: string[], conflict: GateConflict, text: string, involved: GateAppointment[]) => {
    const key = `${targetId}:${conflict.kind}`;
    if (seenManual.has(key)) return;
    seenManual.add(key);
    const changes = involved.map(a => {
      const before = specOf(a);
      const canFlag = a.status === 'booked';
      const after: WindowSpec = canFlag
        ? { ...before, status: 'exception', exception: text }
        : { ...before, exception: before.exception ? `${before.exception}；${text}` : text };
      return { appointmentId: a.id, before, after, expectedVersion: a.version };
    });
    suggestions.push(makeSuggestion('manual-exception', `转人工异常：${targetId}`, [
      `自动调整无法保证放行：${conflict.reason}`,
      involved.some(a => a.status === 'checked-in') ? '车辆已签到，时隙/车道锁定，只登记异常并通知现场复核' : '预约将转入异常队列，由值班员联系车队/海关后手工重排',
    ], ids, targetId, changes, { alwaysFeasible: true }));
  };

  conflicts.forEach(conflict => {
    if (conflict.kind === 'truck-overlap') {
      const [idA, idB] = conflict.appointmentIds;
      const a = getAppt(idA); const b = getAppt(idB);
      if (!a || !b) return;
      // 优先移动仍处于 booked 的一侧；已签到的车辆不允许被自动挪动
      const ordered = [a, b].sort((x, y) => (x.status === 'booked' ? 0 : 1) - (y.status === 'booked' ? 0 : 1));
      const target = ordered[0]; const other = ordered[1];
      const movable = target.status === 'booked';
      const move = movable ? findMove(target, [{ appt: other, requireTurnaround: true }]) : undefined;
      if (move) {
        suggestions.push(makeSuggestion('move-window', `移动窗口：${target.id} 顺延避让 ${other.id}`, [
          conflict.reason,
          `与 ${other.id} 保持 ≥ ${TURNAROUND_MINUTES} 分钟周转间隔，移动后两笔预约互不重叠且车道容量不超限`,
          crossesMidnight(move.windowStart, move.windowEnd) ? '新窗口仍跨日，已按次日排班重新核对夜间值守' : '新窗口位于同一排班日',
        ], [conflict.id], target.id, [changeOf(target, move, conflict.id)]));
      } else if (movable) {
        suggestions.push(makeSuggestion('move-window', `移动窗口：${target.id} 避让 ${other.id}`, [conflict.reason, '未来 6 小时内找不到同时满足周转间隔与车道容量的窗口'], [conflict.id], target.id, [], { blocked: 'NO_FEASIBLE_ADJUSTMENT' }));
      }
      // 拆分处理：把两段作业排成“先后节拍”，顺延 booked 一侧；已签到一侧保持不动
      if (ordered.some(x => x.status === 'booked')) {
        const split = findSplit(a, b);
        if (split) {
          suggestions.push(makeSuggestion('split-processing', `拆分处理：${a.truckNo} 两段作业错峰节拍化`, [
            conflict.reason,
            `先处理 ${split.first.id}（${split.first.windowStart.slice(11, 16)}），${TURNAROUND_MINUTES} 分钟周转后再处理 ${split.second.id}（${split.second.windowStart.slice(11, 16)}）`,
            split.first.status === 'checked-in' || split.second.status === 'checked-in' ? '已签到车辆保持原位，只顺延未签到的一段' : '两段均未签到，顺延窗口已避开容量峰值与同车周转约束',
          ], [conflict.id], split.first.id, split.changes));
        } else {
          suggestions.push(makeSuggestion('split-processing', `拆分处理：${a.truckNo} 两段作业错峰`, [conflict.reason, '两段作业在未来 6 小时内无法拆出满足周转与容量的先后节拍'], [conflict.id], a.id, [], { blocked: 'NO_FEASIBLE_ADJUSTMENT' }));
        }
      }
      pushManual(target.id, [conflict.id], conflict,
        `同车窗口重叠（${other.id}），自动重排不适用，转人工核对到场顺序`, [target, other]);
    }

    if (conflict.kind === 'lane-over-capacity') {
      // 按预约开始时间倒序，逐个尝试疏导仍为 booked 的车辆（海关锁定等不可疏导者会自动跳过）
      const involved = conflict.appointmentIds.map(getAppt).filter((x): x is GateAppointment => Boolean(x)).sort((x, y) => new Date(y.windowStart).getTime() - new Date(x.windowStart).getTime());
      const booked = involved.filter(a => a.status === 'booked');
      const laneTarget = booked.find(a => findLaneChange(a));
      if (laneTarget) {
        const alt = findLaneChange(laneTarget)!;
        suggestions.push(makeSuggestion('change-lane', `换车道：${laneTarget.id} 调至${laneLabel(alt.lane)}`, [
          conflict.reason,
          `${laneLabel(alt.lane)}在该窗口的每个时隙均有空余容量（≤ ${LANE_CAPACITY[alt.lane]} 车），同车道其余车辆保持原时隙`,
          `车道由 ${laneLabel(laneTarget.lane)} 改为 ${laneLabel(alt.lane)}，时间窗口不变，司机与车辆无需改期`,
        ], [conflict.id], laneTarget.id, [changeOf(laneTarget, alt, conflict.id)]));
      } else {
        suggestions.push(makeSuggestion('change-lane', `换车道分流：${conflict.appointmentIds.join('、')}`, [conflict.reason, '其余车道在该窗口同样达到容量上限，或涉及车辆受海关/签到约束不可换道'], [conflict.id], booked[0]?.id ?? conflict.appointmentIds[0], [], { blocked: 'NO_FEASIBLE_ADJUSTMENT' }));
      }
      const moveTarget = booked.find(a => findMove(a, []));
      if (moveTarget) {
        const move = findMove(moveTarget, [])!;
        suggestions.push(makeSuggestion('move-window', `移动窗口：${moveTarget.id} 避开 ${laneLabel(moveTarget.lane)} 峰值`, [
          conflict.reason,
          '改用相邻低谷时隙，车道保持不变',
        ], [conflict.id], moveTarget.id, [changeOf(moveTarget, move, conflict.id)]));
      }
      involved.filter(a => a.status !== 'booked').forEach(a =>
        pushManual(a.id, [conflict.id], conflict, `${laneLabel(conflict.lane!)}峰值超容，车辆已到场，转人工引导分流`, [a]));
    }

    if (conflict.kind === 'customs-pickup-blocked') {
      const target = getAppt(conflict.appointmentIds[0]);
      if (target) pushManual(target.id, [conflict.id], conflict,
        `海关未放行提箱（箱 ${target.containerId}，状态 ${customsOf(target)}），暂扣提箱小票并转海关异常台`, [target]);
    }

    if (conflict.kind === 'cross-midnight') {
      const target = getAppt(conflict.appointmentIds[0]);
      if (!target) return;
      if (target.status === 'booked') {
        const sameDay = findSameDayMove(target);
        if (sameDay) {
          suggestions.push(makeSuggestion('move-window', `移动窗口：${target.id} 收回当日排班`, [
            conflict.reason,
            '窗口整体前移到当日 24:00 之前结束，车道容量与同车周转约束均已重新校验',
          ], [conflict.id], target.id, [changeOf(target, sameDay, conflict.id)]));
        } else {
          suggestions.push(makeSuggestion('move-window', `移动窗口：${target.id} 收回当日排班`, [conflict.reason, '当日没有可容纳整段窗口的空闲时隙，需安排次日预约'], [conflict.id], target.id, [], { blocked: 'NO_FEASIBLE_ADJUSTMENT' }));
        }
      }
      pushManual(target.id, [conflict.id], conflict, '跨日窗口需夜间值守与次日配额双重确认，转人工排班', [target]);
    }
  });

  return {
    generatedAt: new Date(now()).toISOString(),
    windowStart: new Date(start).toISOString(),
    windowEnd: new Date(end).toISOString(),
    slotMinutes: 30,
    laneCapacity: { ...CAP },
    conflicts,
    suggestions: dedupe(suggestions),
    laneLoads,
  };
}

function makeSuggestion(
  kind: SuggestionKind, title: string, reasons: string[], conflictIds: string[],
  targetAppointmentId: string, changes: AppointmentChange[],
  opts?: { blocked?: 'NO_FEASIBLE_ADJUSTMENT'; alwaysFeasible?: boolean },
): ScheduleSuggestion {
  const expectedVersions: Record<string, number> = {};
  changes.forEach(c => { expectedVersions[c.appointmentId] = c.expectedVersion; });
  const signature = [
    kind, targetAppointmentId,
    changes.map(c => `${c.appointmentId}:${c.after.windowStart}|${c.after.windowEnd}|${c.after.lane}|${c.after.status}|${c.after.exception ?? ''}`).join(';'),
  ].join('||');
  return {
    id: `SUG-${hash(signature)}`, kind, title, reasons, conflictIds: [...conflictIds].sort(),
    targetAppointmentId, changes, expectedVersions, createdAt: new Date(now()).toISOString(),
    feasible: opts?.alwaysFeasible ? true : !opts?.blocked && changes.length > 0,
    ...(opts?.blocked ? { blockedReason: opts.blocked } : {}),
  };
}
function changeOf(a: GateAppointment, after: WindowSpec, _conflictId: string): AppointmentChange {
  return { appointmentId: a.id, before: specOf(a), after: { exception: undefined, ...after }, expectedVersion: a.version };
}
function dedupe(list: ScheduleSuggestion[]): ScheduleSuggestion[] {
  const map = new Map<string, ScheduleSuggestion>();
  list.forEach(s => {
    const prev = map.get(s.id);
    if (!prev) { map.set(s.id, s); return; }
    // 同一条建议可能同时化解多个冲突，合并冲突与理由
    const merged: ScheduleSuggestion = {
      ...prev,
      conflictIds: Array.from(new Set([...prev.conflictIds, ...s.conflictIds])).sort(),
      reasons: Array.from(new Set([...prev.reasons, ...s.reasons])),
      feasible: prev.feasible && s.feasible,
      blockedReason: prev.blockedReason ?? s.blockedReason,
    };
    map.set(s.id, merged);
  });
  return Array.from(map.values()).sort((x, y) => x.targetAppointmentId.localeCompare(y.targetAppointmentId) || x.kind.localeCompare(y.kind));
}
function hash(input: string) {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).toUpperCase().padStart(7, '0');
}

interface MoveConstraint { appt: GateAppointment; requireTurnaround?: boolean }

/** 在 -4h…+6h 范围扫描可行的整体窗口平移，优先同排班日、偏移最小的方案 */
function findMove(target: GateAppointment, constraints: MoveConstraint[]): WindowSpec | undefined {
  const duration = new Date(target.windowEnd).getTime() - new Date(target.windowStart).getTime();
  const anchor = Math.floor(new Date(target.windowStart).getTime() / SLOT_MS) * SLOT_MS;
  const candidates: { k: number; spec: WindowSpec }[] = [];
  for (let k = -8; k <= 12; k++) {
    if (k === 0) continue;
    const start = anchor + k * SLOT_MS;
    if (start < now() - SLOT_MS) continue;
    const spec: WindowSpec = { windowStart: new Date(start).toISOString(), windowEnd: new Date(start + duration).toISOString(), lane: target.lane, status: target.status };
    candidates.push({ k, spec });
  }
  candidates.sort((x, y) => {
    const xCross = crossesMidnight(x.spec.windowStart, x.spec.windowEnd) ? 1 : 0;
    const yCross = crossesMidnight(y.spec.windowStart, y.spec.windowEnd) ? 1 : 0;
    if (xCross !== yCross) return xCross - yCross;
    return Math.abs(x.k) - Math.abs(y.k) || x.k - y.k;
  });
  return candidates.find(c => isFeasible(target, c.spec, constraints))?.spec;
}

function findLaneChange(target: GateAppointment): WindowSpec | undefined {
  return LANES.filter(l => l !== target.lane)
    .map(lane => ({ lane, spec: { windowStart: target.windowStart, windowEnd: target.windowEnd, lane, status: target.status } as WindowSpec }))
    .find(c => isFeasible(target, c.spec, []))?.spec;
}

/** 拆分处理：已签到一侧（或较早开始的一段）保持不动，把另一段顺/逆移成独立节拍 */
function findSplit(a: GateAppointment, b: GateAppointment): { first: GateAppointment; second: GateAppointment; changes: AppointmentChange[] } | undefined {
  const byStart = [a, b].sort((x, y) => new Date(x.windowStart).getTime() - new Date(y.windowStart).getTime());
  // 有签到车时以签到车为锚点；双方都未签到时锚定早到的一段
  const anchorAppt = [a, b].find(x => x.status === 'checked-in') ?? byStart[0];
  const movable = anchorAppt.id === a.id ? b : a;
  if (movable.status !== 'booked') return undefined;
  const duration = new Date(movable.windowEnd).getTime() - new Date(movable.windowStart).getTime();
  const base = Math.floor(new Date(movable.windowStart).getTime() / SLOT_MS) * SLOT_MS;
  // 与锚点同序方向（顺延）优先，其次逆向避让
  const order = [...Array.from({ length: 12 }, (_, k) => k + 1), ...Array.from({ length: 8 }, (_, k) => -(k + 1))];
  for (const k of order) {
    const start = base + k * SLOT_MS;
    if (start < now() - SLOT_MS) continue;
    for (const lane of [movable.lane, ...LANES.filter(l => l !== movable.lane)]) {
      const spec: WindowSpec = { windowStart: new Date(start).toISOString(), windowEnd: new Date(start + duration).toISOString(), lane, status: movable.status };
      if (isFeasible(movable, spec, [{ appt: anchorAppt, requireTurnaround: true }])) {
        const ordered = [anchorAppt, movable].sort((x, y) => new Date(x.windowStart).getTime() - new Date(y.windowStart).getTime());
        return { first: ordered[0], second: ordered[1], changes: [changeOf(movable, spec, '')] };
      }
    }
  }
  return undefined;
}

/** 跨日窗口：收回同一排班日，尽量靠近原开始时刻 */
export function findSameDayMove(target: GateAppointment): WindowSpec | undefined {
  const duration = new Date(target.windowEnd).getTime() - new Date(target.windowStart).getTime();
  const dayStart = new Date(target.windowStart);
  const midnight = nextUtcMidnight(new Date(target.windowStart).getTime());
  const dayStartUtc = Date.UTC(dayStart.getUTCFullYear(), dayStart.getUTCMonth(), dayStart.getUTCDate());
  const original = new Date(target.windowStart).getTime();
  const candidates: WindowSpec[] = [];
  for (let start = dayStartUtc; start + duration <= midnight; start += SLOT_MS) {
    if (start < now() - SLOT_MS) continue;
    candidates.push({ windowStart: new Date(start).toISOString(), windowEnd: new Date(start + duration).toISOString(), lane: target.lane, status: target.status });
  }
  candidates.sort((x, y) => Math.abs(new Date(x.windowStart).getTime() - original) - Math.abs(new Date(y.windowStart).getTime() - original));
  return candidates.find(spec => isFeasible(target, spec, []));
}

/** 用实时数据构造假设排法并重放冲突引擎：涉及变更预约的新增冲突一律视为不可行 */
function isFeasible(changed: GateAppointment, spec: WindowSpec, constraints: MoveConstraint[]): boolean {
  const gapMs = TURNAROUND_MINUTES * 60000;
  for (const c of constraints) {
    if (!c.requireTurnaround) continue;
    const s = new Date(spec.windowStart).getTime(); const e = new Date(spec.windowEnd).getTime();
    const os = new Date(c.appt.windowStart).getTime(); const oe = new Date(c.appt.windowEnd).getTime();
    if (!(e + gapMs <= os || oe + gapMs <= s)) return false;
  }
  const hypothetical = appointments.map(a => a.id === changed.id ? { ...a, ...spec } : a);
  const fresh = analyzeConflicts(hypothetical, containers);
  return !fresh.some(cf => cf.appointmentIds.includes(changed.id));
}

// ---- 确认建议：串行化执行，杜绝两个调度员同时确认造成的超容/半写状态 ----
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => T): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

export function confirmSuggestion(suggestionId: string, actor = '闸口值班员', note?: string, clientVersions?: Record<string, number>) {
  return serialize(() => applySuggestion(suggestionId, actor, note, clientVersions));
}

/** 直接提交一份已生成的建议（乐观 UI / 测试入口）：仍走全部实时校验，不跳过任何守卫 */
export function commitSuggestion(suggestion: ScheduleSuggestion, actor = '闸口值班员', note?: string, conflictIdsBefore?: string[]) {
  return serialize(() => commitSuggestionInner(suggestion, actor, note, conflictIdsBefore));
}

function applySuggestion(suggestionId: string, actor: string, note?: string, clientVersions?: Record<string, number>) {
  // 0) 前端基于生成时快照确认：只要客户端点了确认，就先比对相关预约的版本，
  //    这样“另一个调度员先改了单”比“建议失效”更优先地被报出来
  if (clientVersions) {
    for (const [id, expected] of Object.entries(clientVersions)) {
      const appt = getAppt(id);
      if (appt && appt.version !== expected) {
        throw new ScheduleConflictError('VERSION_CONFLICT',
          `预约 ${id} 在建议生成后已被其他调度员修改（版本 ${expected} → ${appt.version}），请刷新冲突后重新确认`,
          { appointmentId: id, expected, current: appt.version });
      }
    }
  }

  const plan = buildSchedulePlan();
  const suggestion = plan.suggestions.find(s => s.id === suggestionId);
  if (!suggestion) {
    const historyHit = getReplanHistory().some(r => r.suggestionId === suggestionId);
    throw new ScheduleConflictError(historyHit ? 'ALREADY_APPLIED' : 'STALE_SUGGESTION',
      historyHit ? '该建议已经确认过，请基于最新冲突列表重新选择处理方式' : '建议已失效（冲突列表已变化），请刷新后重新选择');
  }
  return commitSuggestionInner(suggestion, actor, note, plan.conflicts.map(c => c.id));
}

function commitSuggestionInner(suggestion: ScheduleSuggestion, actor: string, note?: string, conflictIdsBefore?: string[]) {
  if (!suggestion.feasible || !suggestion.changes.length) {
    throw new ScheduleConflictError('NO_FEASIBLE_ADJUSTMENT', '该建议当前没有可行调整，请选择其他建议或转人工', { suggestionId: suggestion.id });
  }

  // 1) 存在性 + 签到锁定
  const live = suggestion.changes.map(c => {
    const appt = getAppt(c.appointmentId);
    if (!appt) throw new ScheduleConflictError('APPOINTMENT_GONE', `预约 ${c.appointmentId} 已被取消或删除`, { appointmentId: c.appointmentId });
    return { change: c, appt };
  });
  live.forEach(({ change, appt }) => {
    const structural = change.after.windowStart !== change.before.windowStart
      || change.after.windowEnd !== change.before.windowEnd || change.after.lane !== change.before.lane;
    if (structural && appt.status !== 'booked') {
      throw new ScheduleConflictError('CHECKED_IN_LOCKED',
        `预约 ${appt.id} 已签到（${appt.status}），车辆已在场，窗口与车道锁定，只能登记人工异常`,
        { appointmentId: appt.id, status: appt.status });
    }
  });

  // 2) 基于实时数据重放：海关状态、车道容量、刚被释放/占用的时隙都按此刻为准
  const customsBlocked = live.find(({ change, appt }) => {
    const structural = change.after.windowStart !== change.before.windowStart
      || change.after.windowEnd !== change.before.windowEnd || change.after.lane !== change.before.lane;
    return structural && appt.type === 'pickup' && customsOf(appt) !== 'released';
  });
  if (customsBlocked) {
    throw new ScheduleConflictError('CUSTOMS_NOT_RELEASED',
      `箱 ${customsBlocked.appt.containerId} 海关尚未放行，不能按新时隙提箱，请转人工异常处理`,
      { appointmentId: customsBlocked.appt.id, customs: customsOf(customsBlocked.appt) });
  }
  const conflictsBeforeNow = conflictIdsBefore ?? analyzeConflicts(appointments, containers).map(c => c.id);
  const hypothetical = appointments.map(a => {
    const change = suggestion.changes.find(c => c.appointmentId === a.id);
    return change ? { ...a, ...change.after } : a;
  });
  const conflictsAfterHypothetical = analyzeConflicts(hypothetical, containers);
  const touched = new Set(suggestion.changes.map(c => c.appointmentId));
  const residual = suggestion.kind === 'manual-exception'
    ? conflictsAfterHypothetical.filter(cf => cf.kind !== 'customs-pickup-blocked' && cf.kind !== 'cross-midnight')
    : conflictsAfterHypothetical;
  const blocking = residual.filter(cf => cf.appointmentIds.some(id => touched.has(id)));
  // 人工异常表示值班员已知晓并接手：残留冲突不阻断，只在改单记录里留作“已知晓冲突”
  if (blocking.length && suggestion.kind !== 'manual-exception') {
    throw new ScheduleConflictError('SLOT_TAKEN',
      `目标时隙在确认瞬间已被占用：${blocking[0].reason}`,
      { conflicts: blocking.map(c => ({ id: c.id, reason: c.reason })) });
  }

  // 3) 原子应用（单线程事件循环内同步完成，不存在半写状态）
  const beforeSpecs = new Map(live.map(({ appt }) => [appt.id, { spec: specOf(appt), version: appt.version }]));
  live.forEach(({ change, appt }) => {
    const structural = change.after.windowStart !== appt.windowStart
      || change.after.windowEnd !== appt.windowEnd || change.after.lane !== appt.lane;
    if (structural) {
      recordRelease({
        appointmentId: appt.id, truckNo: appt.truckNo, lane: appt.lane,
        slotStarts: coveredSlots(appt.windowStart, appt.windowEnd).map(t => new Date(t).toISOString()),
        reason: 'replan',
      });
    }
    Object.assign(appt, change.after);
    appt.version += 1;
  });

  // 4) 留痕：前后差异 + 前后冲突列表
  const conflictsAfter = analyzeConflicts(appointments, containers);
  const record: ReplanRecord = {
    id: `REPLAN-${Date.now()}-${hash(suggestion.id).slice(0, 4)}`,
    at: new Date().toISOString(),
    actor,
    suggestionId: suggestion.id,
    suggestionKind: suggestion.kind,
    ...(note ? { note } : {}),
    reasons: suggestion.reasons,
    changes: live.map(({ appt }) => ({
      appointmentId: appt.id,
      before: beforeSpecs.get(appt.id)!.spec,
      after: specOf(appt),
      versionBefore: beforeSpecs.get(appt.id)!.version,
      versionAfter: appt.version,
    })),
    conflictIdsBefore: conflictsBeforeNow,
    conflictIdsAfter: conflictsAfter.map(c => c.id),
  };
  pushReplan(record);
  auditEvents.unshift({
    id: `AUD-${Date.now()}-${hash(suggestion.id).slice(0, 4)}`,
    actor, action: 'GATE_REPLAN_CONFIRM', entity: 'gate-schedule', entityId: suggestion.targetAppointmentId,
    at: new Date().toISOString(),
    details: JSON.stringify({ suggestionId: suggestion.id, kind: suggestion.kind, note, changes: record.changes }),
  });
  return { record, suggestion, conflictsAfter, plan: buildSchedulePlan() };
}
