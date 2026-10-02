import test from 'node:test';
import assert from 'node:assert/strict';
import { appointments, containers, createGateAppointment, deleteGateAppointment, editGateAppointment, gateConflicts, isCrossDayWindow, updateContainer } from './domain.js';
import { confirmGateSuggestion, findSlotProblems, gateAdjustments, orchestrationBoard } from './gateOrchestrator.js';

const at = (dayOffset: number, hour: number, minute: number) => { const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(hour, minute, 0, 0); return d.toISOString(); };
const cleanup = (...ids: (string | undefined)[]) => { for (const id of ids) if (id && appointments.some(a => a.id === id)) deleteGateAppointment(id); };
const suggestionsFor = (id: string) => orchestrationBoard().suggestions.filter(s => s.appointmentId === id);

test('orchestrator suggests move-window/change-lane and confirm applies atomically with diff', () => {
  const a1 = createGateAppointment({ containerId: 'FCIU-9920310', truckNo: '编排测试车A', driver: '司机甲', type: 'dropoff', windowStart: at(1, 10, 0), windowEnd: at(1, 10, 30), lane: 'north' });
  const a2 = createGateAppointment({ containerId: 'MSCU-4829017', truckNo: '编排测试车A', driver: '司机甲', type: 'dropoff', windowStart: at(1, 10, 15), windowEnd: at(1, 10, 45), lane: 'north' });
  try {
    const board = orchestrationBoard();
    assert.ok(board.conflicts.some(c => c.appointmentId === a1.id && c.reason.includes('重叠')));
    const move = board.suggestions.find(s => s.appointmentId === a1.id && s.kind === 'move-window');
    assert.ok(move?.change, '应给出移动窗口建议');
    assert.ok(!board.suggestions.some(s => s.appointmentId === a1.id && s.kind === 'change-lane'), '同车时间冲突跟着车辆走，换车道无法解决，不应给出该建议');
    assert.ok(move.reason.length > 10);
    const originalStart = a1.windowStart;
    const adjustment = confirmGateSuggestion(move.id, '测试调度员', move.baseVersion);
    assert.equal(adjustment.before[0].windowStart, originalStart);
    assert.equal(adjustment.after[0].windowStart, a1.windowStart);
    assert.notEqual(a1.windowStart, originalStart);
    assert.equal(a1.version, 2);
    assert.equal(gateAdjustments[0].id, adjustment.id);
    assert.ok(!gateConflicts().some(c => c.appointmentId === a1.id), '移动后同车冲突应消失');
    assert.ok(!orchestrationBoard().suggestions.some(s => s.appointmentId === a1.id), '冲突消除后建议应同步清理');
  } finally { cleanup(a1.id, a2.id); }
});

test('concurrent confirms: same suggestion twice, stale sibling and stale version are all rejected without partial writes', () => {
  const d0a = createGateAppointment({ containerId: 'FCIU-9920310', truckNo: '并发占位车A', driver: '司机占甲', type: 'dropoff', windowStart: at(1, 12, 0), windowEnd: at(1, 12, 30), lane: 'north' });
  const d0b = createGateAppointment({ containerId: 'EISU-1288420', truckNo: '并发占位车B', driver: '司机占乙', type: 'dropoff', windowStart: at(1, 12, 0), windowEnd: at(1, 12, 30), lane: 'north' });
  const d1 = createGateAppointment({ containerId: 'MSCU-4829017', truckNo: '并发测试车', driver: '司机乙', type: 'dropoff', windowStart: at(1, 12, 0), windowEnd: at(1, 12, 30), lane: 'north' });
  try {
    const board = orchestrationBoard();
    assert.ok(board.conflicts.some(c => c.appointmentId === d1.id && c.reason.includes('容量')), 'north 容量 2，三车并发应触发容量冲突');
    const move = board.suggestions.find(s => s.appointmentId === d1.id && s.kind === 'move-window')!;
    const lane = board.suggestions.find(s => s.appointmentId === d1.id && s.kind === 'change-lane')!;
    assert.ok(move && lane, '容量冲突应同时给出移动窗口与换车道两条姊妹建议');
    editGateAppointment(d1.id, { driver: '被另一调度员改名' });
    const versionAfterEdit = d1.version;
    assert.throws(() => confirmGateSuggestion(move.id, '调度员乙'), /已被其他调度员修改/, '版本过期应拒绝');
    assert.equal(d1.windowStart, at(1, 12, 0), '失败的确认不能留下部分写入');
    assert.equal(d1.version, versionAfterEdit);
    const fresh = orchestrationBoard().suggestions.find(s => s.appointmentId === d1.id && s.kind === 'move-window')!;
    assert.throws(() => confirmGateSuggestion(fresh.id, '调度员乙', fresh.baseVersion + 99), /版本已变化/, 'expectedVersion 不符应拒绝');
    const applied = confirmGateSuggestion(fresh.id, '调度员甲', fresh.baseVersion);
    assert.equal(applied.actor, '调度员甲');
    assert.throws(() => confirmGateSuggestion(fresh.id, '调度员乙', fresh.baseVersion), /已失效/, '同一建议被两人确认时后者必须失败');
    assert.throws(() => confirmGateSuggestion(lane.id, '调度员乙'), /已失效/, '同预约的姊妹建议应随确认一并作废');
  } finally { cleanup(d0a.id, d0b.id, d1.id); }
});

test('checked-in appointment cannot be rescheduled, only escalated to manual exception', () => {
  const e1 = createGateAppointment({ containerId: 'FCIU-9920310', truckNo: '签到测试车', driver: '司机丙', type: 'dropoff', windowStart: at(1, 14, 0), windowEnd: at(1, 14, 30), lane: 'north' });
  editGateAppointment(e1.id, { status: 'checked-in' });
  const e2 = createGateAppointment({ containerId: 'MSCU-4829017', truckNo: '签到测试车', driver: '司机丙', type: 'dropoff', windowStart: at(1, 14, 15), windowEnd: at(1, 14, 45), lane: 'north' });
  try {
    const kinds = suggestionsFor(e1.id).map(s => s.kind);
    assert.deepEqual(kinds, ['escalate'], '已签到预约只应给出转人工建议');
    const escalate = suggestionsFor(e1.id)[0];
    assert.ok(escalate.reason.includes('签到'));
    const adjustment = confirmGateSuggestion(escalate.id, '测试调度员', escalate.baseVersion);
    assert.equal(adjustment.after[0].status, 'exception');
    assert.equal(e1.status, 'exception');
    assert.ok(e1.exception);
    assert.ok(!gateConflicts().some(c => c.appointmentId === e1.id), '转异常后不再占用冲突列表');
  } finally { cleanup(e1.id, e2.id); updateContainer('FCIU-9920310', { status: 'in-yard' }); }
});

test('cross-day window is flagged and split into two same-day appointments at midnight boundary', () => {
  const start = new Date(); start.setHours(23, 30, 0, 0);
  const end = new Date(start.getTime() + 60 * 60000);
  const x1 = createGateAppointment({ containerId: 'FCIU-9920310', truckNo: '跨日测试车', driver: '司机丁', type: 'dropoff', windowStart: start.toISOString(), windowEnd: end.toISOString(), lane: 'rail' });
  let secondId: string | undefined;
  try {
    const board = orchestrationBoard();
    assert.ok(board.conflicts.some(c => c.appointmentId === x1.id && c.reason.includes('窗口跨日')));
    const split = board.suggestions.find(s => s.appointmentId === x1.id && s.kind === 'split');
    assert.ok(split?.split, '跨日窗口应给出拆分建议');
    const boundary = new Date(start); boundary.setHours(24, 0, 0, 0);
    const adjustment = confirmGateSuggestion(split.id, '测试调度员', split.baseVersion);
    assert.equal(adjustment.after.length, 2);
    assert.equal(adjustment.before.length, 1);
    secondId = adjustment.after[1].id;
    assert.equal(new Date(x1.windowEnd).getTime(), boundary.getTime(), '第一段应在午夜结束');
    const second = appointments.find(a => a.id === secondId)!;
    assert.equal(new Date(second.windowStart).getTime(), boundary.getTime(), '第二段应在午夜开始');
    assert.equal(second.windowEnd, end.toISOString());
    assert.equal(second.status, 'booked');
    assert.ok(!isCrossDayWindow(x1.windowStart, x1.windowEnd) && !isCrossDayWindow(second.windowStart, second.windowEnd));
    assert.ok(!gateConflicts().some(c => c.reason.includes('窗口跨日') && (c.appointmentId === x1.id || c.appointmentId === secondId)), '拆分后跨日警告应消除');
    assert.ok(!gateConflicts().some(c => c.appointmentId === x1.id || c.appointmentId === secondId), '拆分产生的同箱相邻两段是同一次连续作业，不应再有任何冲突');
  } finally { cleanup(x1.id, secondId); }
});

test('cancelled appointment frees its slot so the same window can be re-occupied, and lane capacity is still enforced', () => {
  const y1 = createGateAppointment({ containerId: 'FCIU-9920310', truckNo: '释放测试车A', driver: '司机戊', type: 'dropoff', windowStart: at(1, 16, 0), windowEnd: at(1, 16, 30), lane: 'rail' });
  let y2: ReturnType<typeof createGateAppointment> | undefined;
  let y3: ReturnType<typeof createGateAppointment> | undefined;
  try {
    editGateAppointment(y1.id, { status: 'cancelled' });
    assert.equal(containers.find(c => c.id === 'FCIU-9920310')?.appointmentId, undefined, '取消后箱预约关联应释放');
    y2 = createGateAppointment({ containerId: 'MSCU-4829017', truckNo: '释放测试车B', driver: '司机己', type: 'dropoff', windowStart: at(1, 16, 0), windowEnd: at(1, 16, 30), lane: 'rail' });
    assert.ok(y2.id);
    const conflicts = gateConflicts();
    assert.ok(!conflicts.some(c => c.appointmentId === y1.id), '已取消预约不应再出现在冲突列表');
    assert.ok(!conflicts.some(c => c.appointmentId === y2!.id), '原时隙被取消后应可无冲突再占用');
    assert.equal(findSlotProblems({ id: 'PROBE', containerId: 'FCIU-9920310', truckNo: '释放测试车A', type: 'dropoff', windowStart: at(1, 16, 0), windowEnd: at(1, 16, 30), lane: 'north' }).length, 0, '取消释放的同车窗口应可复用');
    y3 = createGateAppointment({ containerId: 'EISU-1288420', truckNo: '释放测试车C', driver: '司机庚', type: 'dropoff', windowStart: at(1, 16, 0), windowEnd: at(1, 16, 30), lane: 'rail' });
    assert.ok(gateConflicts().some(c => c.reason.includes('容量') && (c.appointmentId === y2!.id || c.appointmentId === y3!.id)), 'rail 容量为 1，第二车并发应触发容量冲突');
    assert.ok(suggestionsFor(y2!.id).some(s => s.kind === 'change-lane'), '车道容量冲突应给出换车道建议');
  } finally { cleanup(y1.id, y2?.id, y3?.id); }
});

test('pickup with customs hold only gets manual-exception suggestion and leaves conflict list after confirm', () => {
  const z1 = createGateAppointment({ containerId: 'CMAU-6001722', truckNo: '海关测试车', driver: '司机辛', type: 'pickup', windowStart: at(1, 18, 0), windowEnd: at(1, 18, 30), lane: 'north' });
  try {
    updateContainer('CMAU-6001722', { customs: 'hold' });
    assert.ok(gateConflicts().some(c => c.appointmentId === z1.id && c.reason.includes('海关')));
    assert.ok(findSlotProblems({ containerId: 'CMAU-6001722', truckNo: '海关测试车', type: 'pickup', windowStart: at(1, 19, 0), windowEnd: at(1, 19, 30), lane: 'north' }).some(p => p.includes('海关')), '海关未放行时任何提箱时隙都不可行');
    const kinds = suggestionsFor(z1.id).map(s => s.kind);
    assert.deepEqual(kinds, ['escalate'], '海关未放行提箱只应转人工异常');
    const escalate = suggestionsFor(z1.id)[0];
    assert.ok(escalate.reason.includes('海关'));
    confirmGateSuggestion(escalate.id, '测试调度员', escalate.baseVersion);
    assert.equal(z1.status, 'exception');
    assert.ok(!gateConflicts().some(c => c.appointmentId === z1.id), '转异常后冲突列表与预约状态保持一致');
  } finally { cleanup(z1.id); updateContainer('CMAU-6001722', { customs: 'released' }); }
});
