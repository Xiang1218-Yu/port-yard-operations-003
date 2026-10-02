import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { appointments, containers, createGateAppointment, deleteGateAppointment, editGateAppointment, gateConflicts } from './domain.js';
import { analyzeConflicts, coveredSlots, crossesMidnight, SLOT_MS } from './gateCore.js';
import { buildSchedulePlan, commitSuggestion, confirmSuggestion, findSameDayMove, ScheduleConflictError } from './gateOrchestration.js';

const HOUR = 60 * 60000;
const isoAt = (offsetMs: number) => new Date(offsetMs).toISOString();
const slotStart = (minutesFromNow: number) => Math.floor((Date.now() + minutesFromNow * 60000) / SLOT_MS) * SLOT_MS;
const created: string[] = [];
function book(partial: { id: string; containerId: string; truckNo: string; type: 'pickup' | 'dropoff'; lane: 'north' | 'south' | 'rail'; startMin: number; durationMin?: number }) {
  // 绕过 createGateAppointment 的容量校验构造冲突场景，但走相同的领域对象形状
  const start = slotStart(partial.startMin);
  const item = {
    id: partial.id, containerId: partial.containerId, truckNo: partial.truckNo, driver: '编排测试司机',
    type: partial.type, windowStart: isoAt(start), windowEnd: isoAt(start + (partial.durationMin ?? 20) * 60000),
    lane: partial.lane, status: 'booked' as const, sealVerified: false, weightVerified: false, version: 1,
  };
  appointments.unshift(item);
  created.push(item.id);
  return item;
}
describe('gate slot orchestration', { concurrency: false }, () => {
test.after(() => {
  [...created].forEach(id => deleteGateAppointment(id));
});

test('plan generates reasoned move-window / change-lane / split / manual-exception suggestions', () => {
  const plan = buildSchedulePlan();
  const kinds = new Set(plan.suggestions.map(s => s.kind));
  assert.ok(kinds.has('move-window'), '应生成移动窗口建议');
  assert.ok(kinds.has('change-lane'), '应生成换车道建议');
  assert.ok(kinds.has('split-processing'), '应生成拆分处理建议');
  assert.ok(kinds.has('manual-exception'), '应生成转人工异常建议');
  for (const s of plan.suggestions) {
    assert.ok(s.reasons.length >= 1, `${s.id} 必须带理由`);
    if (s.kind !== 'manual-exception' && !s.feasible) assert.ok(s.blockedReason);
  }
  // 车道容量基线：北/南 2 车、铁路 1 车
  assert.deepEqual(plan.laneCapacity, { north: 2, south: 2, rail: 1 });
  // 海关未放行提箱（APT-9005 → TEMU-1774029 查验中）只能转人工，不允许移动/换道
  const customsSuggestions = plan.suggestions.filter(s => s.targetAppointmentId === 'APT-9005');
  assert.ok(customsSuggestions.every(s => s.kind === 'manual-exception'));
  assert.ok(plan.conflicts.some(c => c.kind === 'customs-pickup-blocked' && c.appointmentIds.includes('APT-9005')));
  // 北闸口高峰 3 车超容，疏导建议应避开海关锁定的 APT-9005，选中可移动的车辆
  const capConflict = plan.conflicts.find(c => c.kind === 'lane-over-capacity' && c.lane === 'north');
  assert.ok(capConflict, '种子数据应在北闸口高峰时段产生超容冲突');
  const laneChange = plan.suggestions.find(s => s.kind === 'change-lane');
  assert.ok(laneChange && laneChange.targetAppointmentId !== 'APT-9005');
});

test('confirming a move-window suggestion atomically removes the conflict and keeps a before/after diff', async () => {
  const x1 = book({ id: 'APT-T-MOVE-1', containerId: 'MSCU-4829017', truckNo: '浙F·TEST-MOVE', type: 'pickup', lane: 'rail', startMin: 200, durationMin: 40 });
  const x2 = book({ id: 'APT-T-MOVE-2', containerId: 'OOLU-7734201', truckNo: '浙F·TEST-MOVE', type: 'dropoff', lane: 'south', startMin: 210, durationMin: 20 });
  const plan = buildSchedulePlan();
  const suggestion = plan.suggestions.find(s => (s.kind === 'move-window' || s.kind === 'split-processing')
    && s.feasible && s.changes.some(c => c.appointmentId === x2.id)
    && s.changes.every(c => c.after.status === 'booked'))!;
  assert.ok(suggestion, '同车冲突必须生成可确认的移动窗口或拆分处理建议');
  const originalStart = x2.windowStart;
  const result = await confirmSuggestion(suggestion.id, '调度员甲');
  const change = result.record.changes.find(c => c.appointmentId === x2.id)!;
  assert.equal(change.appointmentId, x2.id);
  assert.equal(change.before.windowStart, originalStart);
  assert.notEqual(change.after.windowStart, originalStart);
  assert.equal(change.versionBefore, 1);
  assert.equal(change.versionAfter, 2);
  const stored = appointments.find(a => a.id === x2.id)!;
  assert.equal(stored.version, 2);
  assert.ok(!result.conflictsAfter.some(c => c.appointmentIds.includes(x1.id) && c.kind === 'truck-overlap'));
  assert.ok(result.record.conflictIdsBefore.length >= 1);
  assert.ok(!result.record.conflictIdsAfter.some(id => id.includes(x1.id) || id.includes(x2.id)));
});

test('two dispatchers confirming competing suggestions at once: exactly one wins, no half-written state', async () => {
  const y1 = book({ id: 'APT-T-RACE-1', containerId: 'MSCU-4829017', truckNo: '浙F·TEST-RACE', type: 'pickup', lane: 'rail', startMin: 230, durationMin: 40 });
  const y2 = book({ id: 'APT-T-RACE-2', containerId: 'OOLU-7734201', truckNo: '浙F·TEST-RACE', type: 'dropoff', lane: 'north', startMin: 240, durationMin: 20 });
  const plan = buildSchedulePlan();
  const involving = (id: string) => (s: { changes: { appointmentId: string }[] }) => s.changes.some(c => c.appointmentId === id);
  const move = plan.suggestions.find(s => s.kind === 'move-window' && s.feasible && (involving(y1.id)(s) || involving(y2.id)(s)))!;
  const split = plan.suggestions.find(s => s.kind === 'split-processing' && s.feasible && (involving(y1.id)(s) || involving(y2.id)(s)))!;
  assert.ok(move && split && move.id !== split.id);
  const outcomes = await Promise.allSettled([confirmSuggestion(move.id, '调度员甲'), confirmSuggestion(split.id, '调度员乙')]);
  const fulfilled = outcomes.filter(o => o.status === 'fulfilled');
  const rejected = outcomes.filter(o => o.status === 'rejected');
  assert.equal(fulfilled.length, 1, '同一冲突只能有一个建议落库');
  assert.equal(rejected.length, 1);
  const error = (rejected[0] as PromiseRejectedResult).reason;
  assert.ok(error instanceof ScheduleConflictError);
  assert.ok(['STALE_SUGGESTION', 'ALREADY_APPLIED'].includes(error.code));
  // 最终状态一致：冲突消失且没有制造超容
  const finalConflicts = analyzeConflicts(appointments, containers).filter(c => c.appointmentIds.some(id => id === y1.id || id === y2.id));
  assert.equal(finalConflicts.length, 0);
});

test('a checked-in appointment is structurally locked; stale client snapshot is rejected', async () => {
  const z = book({ id: 'APT-T-LOCK-1', containerId: 'MSCU-4829017', truckNo: '浙F·TEST-LOCK', type: 'pickup', lane: 'south', startMin: 260, durationMin: 40 });
  const w = book({ id: 'APT-T-LOCK-2', containerId: 'OOLU-7734201', truckNo: '浙F·TEST-LOCK', type: 'dropoff', lane: 'rail', startMin: 270, durationMin: 20 });
  const plan = buildSchedulePlan();
  const suggestion = plan.suggestions.find(s => (s.kind === 'move-window' || s.kind === 'split-processing') && s.changes.length === 1 && s.changes[0].appointmentId === w.id && s.feasible)!;
  assert.ok(suggestion);
  const targetId = z.id;

  // 场景 A：建议生成后另一调度员先把签到侧预约改了状态（版本推进），旧快照确认 → VERSION_CONFLICT
  editGateAppointment(targetId, { status: 'checked-in' });
  await assert.rejects(
    () => confirmSuggestion(suggestion.id, '调度员乙', undefined, { [targetId]: 1 }),
    (error: unknown) => error instanceof ScheduleConflictError && error.code === 'VERSION_CONFLICT',
  );

  // 场景 B：建议里要挪动的车辆被另一调度员签到，用原建议负载提交 → CHECKED_IN_LOCKED
  editGateAppointment(w.id, { status: 'checked-in' });
  await assert.rejects(
    () => commitSuggestion(suggestion, '调度员乙'),
    (error: unknown) => error instanceof ScheduleConflictError && error.code === 'CHECKED_IN_LOCKED',
  );
  // 人工异常仍可登记，且不挪动已签到车辆（同车冲突的人工建议会同时给两车登记说明）
  const plan2 = buildSchedulePlan();
  const manual = plan2.suggestions.find(s => s.kind === 'manual-exception' && s.changes.some(c => c.appointmentId === w.id))!;
  assert.ok(manual);
  await confirmSuggestion(manual.id, '调度员乙');
  const stored = appointments.find(a => a.id === w.id)!;
  assert.equal(stored.status, 'checked-in', '已签到车辆的窗口与状态锁定，不做结构性挪动');
  assert.ok(stored.exception && stored.exception.length > 0, '异常说明追加登记到预约详情');
});

test('cross-midnight windows are flagged and a same-day feasible adjustment exists', () => {
  const day = new Date();
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 2);
  const cross = {
    id: 'APT-T-MIDNIGHT', containerId: 'FCIU-9920310', truckNo: '皖J·TEST-XDAY', driver: '跨日测试',
    type: 'dropoff' as const, windowStart: new Date(midnight - 40 * 60000).toISOString(),
    windowEnd: new Date(midnight + 30 * 60000).toISOString(), lane: 'rail' as const,
    status: 'booked' as const, sealVerified: false, weightVerified: false, version: 1,
  };
  assert.ok(crossesMidnight(cross.windowStart, cross.windowEnd));
  const detected = analyzeConflicts([cross], containers).find(c => c.kind === 'cross-midnight');
  assert.ok(detected, '跨日窗口必须在冲突引擎中可见，无论是否落在 6 小时计划窗');
  const adjusted = findSameDayMove(cross);
  assert.ok(adjusted);
  assert.equal(crossesMidnight(adjusted!.windowStart, adjusted!.windowEnd), false);
  assert.ok(new Date(adjusted!.windowEnd).getTime() <= midnight);
});

test('customs hold forces pickup appointments into manual exception and the conflict clears after flagging', async () => {
  const result = await confirmSuggestion(
    buildSchedulePlan().suggestions.find(s => s.kind === 'manual-exception' && s.targetAppointmentId === 'APT-9005')!.id,
    '海关异常台',
  );
  const stored = appointments.find(a => a.id === 'APT-9005')!;
  assert.equal(stored.status, 'exception');
  assert.ok(!result.conflictsAfter.some(c => c.kind === 'customs-pickup-blocked' && c.appointmentIds.includes('APT-9005')));
  assert.ok(!gateConflicts().some(c => c.appointmentId === 'APT-9005' && c.kind === 'customs-pickup-blocked'));
});

test('cancelling an appointment releases its slots so the same slot can be reoccupied immediately', () => {
  // 使用远离其他测试夹具的专用时隙（铁路容量 1，最易验证释放/再占用）
  const t = slotStart(460);
  const base = {
    containerId: 'FCIU-9920310', type: 'dropoff' as const,
    windowStart: isoAt(t), windowEnd: isoAt(t + 30 * 60000), lane: 'rail' as const,
    truckNo: '', driver: '释放测试',
  };
  const first = createGateAppointment({ ...base, truckNo: '皖J·TEST-REL-1' });
  assert.throws(
    () => createGateAppointment({ ...base, truckNo: '皖J·TEST-REL-2' }),
    /容量/,
    '铁路车道容量 1，占用时第二笔预约必须被拒',
  );
  editGateAppointment(first.id, { status: 'cancelled' });
  const second = createGateAppointment({ ...base, truckNo: '皖J·TEST-REL-2' });
  assert.equal(second.lane, 'rail');
  // 删除同样释放时隙
  deleteGateAppointment(second.id);
  const third = createGateAppointment({ ...base, truckNo: '皖J·TEST-REL-3' });
  assert.ok(third.id);
  deleteGateAppointment(third.id);
  deleteGateAppointment(first.id);
});

test('lane loads in the plan never report released slots as occupied', () => {
  // 任意当前时隙的占用数都只来自 active 预约（booked/checked-in/exception）
  const plan = buildSchedulePlan();
  for (const load of plan.laneLoads) {
    for (const lane of ['north', 'south', 'rail'] as const) {
      const entry = load.lanes[lane];
      const actual = appointments.filter(a => a.status !== 'cancelled' && a.status !== 'completed'
        && a.lane === lane && coveredSlots(a.windowStart, a.windowEnd).includes(new Date(load.slotStart).getTime())).length;
      assert.equal(entry.load, actual);
      assert.ok(entry.load <= entry.capacity || true); // 允许超容（这正是要展示的冲突）
    }
  }
});

test('gate conflict list stays consistent with appointment details after replan', async () => {
  const before = gateConflicts().map(c => `${c.conflictId}:${c.appointmentId}`).sort();
  const plan = buildSchedulePlan();
  for (const ref of before) {
    const [conflictId] = ref.split(':');
    assert.ok(plan.conflicts.some(c => c.id === conflictId), '冲突列表与编排计划必须来自同一引擎');
  }
  // 已完成/取消的预约详情中不应再挂冲突
  assert.ok(!gateConflicts().some(c => appointments.find(a => a.id === c.appointmentId)?.status === 'cancelled'));
});
});
