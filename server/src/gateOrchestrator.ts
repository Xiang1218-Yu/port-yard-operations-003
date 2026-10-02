import { appointments, auditEvents, containers, gateConflicts, isActiveAppointment, isCrossDayWindow, laneCapacity, TRUCK_TURNAROUND_MINUTES } from './domain.js';
import type { GateAppointment } from './domain.js';

export type SuggestionKind = 'move-window' | 'change-lane' | 'split' | 'escalate';
export interface SlotChange { windowStart: string; windowEnd: string; lane: GateAppointment['lane']; }
export interface GateSuggestion {
  id: string; appointmentId: string; kind: SuggestionKind; reason: string;
  change?: SlotChange; split?: { first: SlotChange; second: SlotChange };
  baseVersion: number; createdAt: string;
}
export interface AppointmentSnapshot {
  id: string; containerId: string; truckNo: string; driver: string; type: GateAppointment['type'];
  windowStart: string; windowEnd: string; lane: GateAppointment['lane'];
  status: GateAppointment['status']; exception?: string; version: number;
}
export interface GateAdjustment {
  id: string; suggestionId: string; kind: SuggestionKind; actor: string; reason: string; at: string;
  appointmentIds: string[]; before: AppointmentSnapshot[]; after: AppointmentSnapshot[];
}

const LANES: GateAppointment['lane'][] = ['north', 'south', 'rail'];
const MOVE_STEP_MINUTES = 15;
const MOVE_SEARCH_STEPS = 32; // 以 15 分钟步进向前扫描 8 小时
const MAX_WINDOW_MINUTES = 90; // 单窗时长上限，超过建议拆分

const pendingSuggestions = new Map<string, GateSuggestion>();
export const gateAdjustments: GateAdjustment[] = [];
let sequence = 1;

const snapshot = (a: GateAppointment): AppointmentSnapshot => ({
  id: a.id, containerId: a.containerId, truckNo: a.truckNo, driver: a.driver, type: a.type,
  windowStart: a.windowStart, windowEnd: a.windowEnd, lane: a.lane, status: a.status,
  ...(a.exception ? { exception: a.exception } : {}), version: a.version
});
const fmt = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

interface SlotCandidate { id?: string; containerId: string; truckNo: string; type: GateAppointment['type']; windowStart: string; windowEnd: string; lane: GateAppointment['lane']; }

export function laneLoadAt(lane: GateAppointment['lane'], windowStart: string, windowEnd: string, ignoreIds: string[] = []) {
  const start = new Date(windowStart).getTime(); const end = new Date(windowEnd).getTime();
  return appointments.filter(a => isActiveAppointment(a) && a.lane === lane && !ignoreIds.includes(a.id))
    .filter(a => new Date(a.windowStart).getTime() < end && start < new Date(a.windowEnd).getTime()).length;
}

// 汇总一个候选时隙在当前预约池上的全部硬约束问题；返回空数组表示可行
export function findSlotProblems(candidate: SlotCandidate, ignoreIds: string[] = []): string[] {
  const problems: string[] = [];
  const start = new Date(candidate.windowStart).getTime(); const end = new Date(candidate.windowEnd).getTime();
  if (!(end > start)) problems.push('窗口结束时间必须晚于开始时间');
  const container = containers.find(item => item.id === candidate.containerId);
  if (!container) problems.push(`箱 ${candidate.containerId} 不存在`);
  else if (candidate.type === 'pickup' && container.customs !== 'released') problems.push(`箱 ${container.id} 海关未放行（${container.customs}），不能安排提箱时隙`);
  let laneLoad = 0;
  for (const other of appointments) {
    if (!isActiveAppointment(other) || other.id === candidate.id || ignoreIds.includes(other.id)) continue;
    const otherStart = new Date(other.windowStart).getTime(); const otherEnd = new Date(other.windowEnd).getTime();
    const overlap = start < otherEnd && otherStart < end;
    if (other.truckNo === candidate.truckNo) {
      if (overlap) problems.push(`车辆 ${other.truckNo} 与 ${other.id} 窗口重叠`);
      else {
        const gap = otherStart >= end ? otherStart - end : start - otherEnd;
        const continuousVisit = gap === 0 && other.containerId === candidate.containerId; // 拆分产生的同箱相邻两段不记周转冲突
        if (gap < TRUCK_TURNAROUND_MINUTES * 60000 && !continuousVisit) problems.push(`车辆 ${other.truckNo} 与 ${other.id} 间隔不足 ${TRUCK_TURNAROUND_MINUTES} 分钟`);
      }
    }
    if (overlap && other.containerId === candidate.containerId) problems.push(`箱 ${other.containerId} 在相同时隙已被 ${other.id} 占用`);
    if (overlap && other.lane === candidate.lane) laneLoad += 1;
  }
  if (laneLoad >= laneCapacity[candidate.lane]) problems.push(`车道 ${candidate.lane} 该时隙容量已满（${laneLoad}/${laneCapacity[candidate.lane]}）`);
  return problems;
}

function moveWindowFor(a: GateAppointment): SlotChange | undefined {
  const start = new Date(a.windowStart).getTime(); const duration = new Date(a.windowEnd).getTime() - start;
  const dayEnd = new Date(a.windowStart); dayEnd.setHours(24, 0, 0, 0); // 移动窗口不制造新的跨日，跨日交给拆分
  for (let i = 1; i <= MOVE_SEARCH_STEPS; i++) {
    const candidateStart = start + i * MOVE_STEP_MINUTES * 60000;
    if (candidateStart + duration > dayEnd.getTime()) break;
    const change: SlotChange = { windowStart: new Date(candidateStart).toISOString(), windowEnd: new Date(candidateStart + duration).toISOString(), lane: a.lane };
    if (!findSlotProblems({ ...a, ...change }, [a.id]).length) return change;
  }
  return undefined;
}

function changeLaneFor(a: GateAppointment): SlotChange | undefined {
  for (const lane of LANES) {
    if (lane === a.lane) continue;
    const change: SlotChange = { windowStart: a.windowStart, windowEnd: a.windowEnd, lane };
    if (!findSlotProblems({ ...a, ...change }, [a.id]).length) return change;
  }
  return undefined;
}

function splitPlanFor(a: GateAppointment): { first: SlotChange; second: SlotChange } | undefined {
  const start = new Date(a.windowStart); const end = new Date(a.windowEnd);
  let boundary: Date | undefined;
  if (isCrossDayWindow(a.windowStart, a.windowEnd)) { boundary = new Date(start); boundary.setHours(24, 0, 0, 0); }
  else if (end.getTime() - start.getTime() > MAX_WINDOW_MINUTES * 60000) {
    const half = Math.floor((end.getTime() - start.getTime()) / 2 / (MOVE_STEP_MINUTES * 60000)) * MOVE_STEP_MINUTES * 60000;
    boundary = new Date(start.getTime() + half);
  }
  if (!boundary || boundary <= start || boundary >= end) return undefined;
  const first: SlotChange = { windowStart: start.toISOString(), windowEnd: boundary.toISOString(), lane: a.lane };
  const second: SlotChange = { windowStart: boundary.toISOString(), windowEnd: end.toISOString(), lane: a.lane };
  if (findSlotProblems({ ...a, ...first }, [a.id]).length) return undefined;
  if (findSlotProblems({ ...a, ...second }, [a.id]).length) return undefined;
  return { first, second };
}

function addSuggestion(appointment: GateAppointment, kind: SuggestionKind, reason: string, extra: Partial<GateSuggestion> = {}) {
  const id = `SUG-${appointment.id}-${kind}`;
  if (pendingSuggestions.has(id)) return;
  pendingSuggestions.set(id, { id, appointmentId: appointment.id, kind, reason, baseVersion: appointment.version, createdAt: new Date().toISOString(), ...extra });
}

// 预约被编辑/删除/确认后版本号变化，旧建议自动作废，保证建议池与预约详情一致
export function pruneSuggestions() {
  for (const [id, suggestion] of pendingSuggestions) {
    const appointment = appointments.find(item => item.id === suggestion.appointmentId);
    if (!appointment || appointment.version !== suggestion.baseVersion) pendingSuggestions.delete(id);
  }
}

export function generateSuggestions(): GateSuggestion[] {
  pruneSuggestions();
  const conflictedIds = [...new Set(gateConflicts().map(item => item.appointmentId))];
  for (const id of conflictedIds) {
    const appointment = appointments.find(item => item.id === id);
    if (!appointment || !isActiveAppointment(appointment)) continue;
    if ([...pendingSuggestions.values()].some(s => s.appointmentId === id)) continue;
    const container = containers.find(item => item.id === appointment.containerId);
    if (appointment.status !== 'booked') {
      addSuggestion(appointment, 'escalate', `预约已${appointment.status === 'checked-in' ? '签到进场' : '关闭'}，自动改派不可行，转人工异常现场处理`);
      continue;
    }
    if (appointment.type === 'pickup' && container?.customs !== 'released') {
      addSuggestion(appointment, 'escalate', `箱 ${appointment.containerId} 海关未放行（${container?.customs}），时隙调整无法解决，转人工异常跟进查验进度`);
      continue;
    }
    let offered = false;
    const crossDay = isCrossDayWindow(appointment.windowStart, appointment.windowEnd);
    const durationMinutes = (new Date(appointment.windowEnd).getTime() - new Date(appointment.windowStart).getTime()) / 60000;
    if (crossDay || durationMinutes > MAX_WINDOW_MINUTES) {
      const split = splitPlanFor(appointment);
      if (split) {
        addSuggestion(appointment, 'split', crossDay
          ? `窗口跨日，在午夜班次边界拆分为 ${fmt(split.first.windowStart)}–${fmt(split.first.windowEnd)} 与 ${fmt(split.second.windowStart)}–${fmt(split.second.windowEnd)} 两段`
          : `窗口时长 ${Math.round(durationMinutes)} 分钟超过单窗上限 ${MAX_WINDOW_MINUTES} 分钟，拆分为两段平滑车道负载`, { split });
        offered = true;
      }
    }
    const change = changeLaneFor(appointment);
    if (change) {
      const free = laneCapacity[change.lane] - laneLoadAt(change.lane, change.windowStart, change.windowEnd, [appointment.id]);
      addSuggestion(appointment, 'change-lane', `车道 ${appointment.lane} 冲突，${change.lane} 车道同时段还有 ${free}/${laneCapacity[change.lane]} 容量，可原窗口平移`, { change });
      offered = true;
    }
    const move = moveWindowFor(appointment);
    if (move) {
      addSuggestion(appointment, 'move-window', `同车道按 ${MOVE_STEP_MINUTES} 分钟步进扫描，${fmt(move.windowStart)}–${fmt(move.windowEnd)} 无同车重叠且容量充足`, { change: move });
      offered = true;
    }
    if (!offered) addSuggestion(appointment, 'escalate', '搜索范围内没有可行的窗口/车道组合，转人工异常协调');
  }
  return [...pendingSuggestions.values()];
}

export function orchestrationBoard() {
  const suggestions = generateSuggestions();
  const lanes = LANES.map(lane => {
    const list = appointments.filter(a => isActiveAppointment(a) && a.lane === lane);
    const points = [...new Set(list.flatMap(a => [a.windowStart, a.windowEnd]))];
    const peakLoad = points.reduce((max, point) => {
      const at = new Date(point).getTime();
      return Math.max(max, list.filter(a => new Date(a.windowStart).getTime() <= at && at < new Date(a.windowEnd).getTime()).length);
    }, 0);
    return { lane, capacity: laneCapacity[lane], active: list.length, peakLoad };
  });
  return { conflicts: gateConflicts(), suggestions, lanes, adjustments: gateAdjustments.slice(0, 20) };
}

// 值班员确认建议：先整体校验（版本、状态、当前可行性），通过后同步一次性落库，失败不落任何数据
export function confirmGateSuggestion(suggestionId: string, actor: string, expectedVersion?: number): GateAdjustment {
  const suggestion = pendingSuggestions.get(suggestionId);
  if (!suggestion) throw new Error('建议已失效或已被其他调度员处理，请刷新后重试');
  const appointment = appointments.find(item => item.id === suggestion.appointmentId);
  if (!appointment) { pendingSuggestions.delete(suggestionId); throw new Error('关联预约已不存在，建议自动作废'); }
  if (appointment.version !== suggestion.baseVersion) { pendingSuggestions.delete(suggestionId); throw new Error('预约已被其他调度员修改，建议已作废，请重新计算'); }
  if (expectedVersion !== undefined && expectedVersion !== appointment.version) throw new Error('预约版本已变化，存在并发操作，请刷新后重试');

  const before = [snapshot(appointment)];
  let after: AppointmentSnapshot[];
  let affectedIds: string[];

  if (suggestion.kind === 'escalate') {
    if (!isActiveAppointment(appointment)) { pendingSuggestions.delete(suggestionId); throw new Error(`预约已${appointment.status === 'completed' ? '完成' : '取消'}，无需转异常`); }
    appointment.status = 'exception';
    appointment.exception = suggestion.reason;
    appointment.version += 1;
    after = [snapshot(appointment)]; affectedIds = [appointment.id];
  } else if (suggestion.kind === 'split') {
    if (appointment.status !== 'booked') { pendingSuggestions.delete(suggestionId); throw new Error('预约已签到或已关闭，不能拆分窗口'); }
    const { first, second } = suggestion.split!;
    const problems = [...findSlotProblems({ ...appointment, ...first }, [appointment.id]), ...findSlotProblems({ ...appointment, ...second }, [appointment.id])];
    if (problems.length) { pendingSuggestions.delete(suggestionId); throw new Error(`调整方案已不可行：${problems[0]}`); }
    Object.assign(appointment, { windowStart: first.windowStart, windowEnd: first.windowEnd, lane: first.lane });
    appointment.version += 1;
    const secondAppointment: GateAppointment = { ...appointment, id: `APT-${Date.now()}-S${sequence}`, windowStart: second.windowStart, windowEnd: second.windowEnd, lane: second.lane, status: 'booked', sealVerified: false, weightVerified: false, exception: undefined, version: 1 };
    appointments.unshift(secondAppointment);
    after = [snapshot(appointment), snapshot(secondAppointment)]; affectedIds = [appointment.id, secondAppointment.id];
  } else {
    if (appointment.status !== 'booked') { pendingSuggestions.delete(suggestionId); throw new Error('预约已签到或已关闭，不能调整时隙/车道'); }
    const change = suggestion.change!;
    const problems = findSlotProblems({ ...appointment, ...change }, [appointment.id]);
    if (problems.length) { pendingSuggestions.delete(suggestionId); throw new Error(`调整方案已不可行：${problems[0]}`); }
    Object.assign(appointment, change);
    appointment.version += 1;
    after = [snapshot(appointment)]; affectedIds = [appointment.id];
  }

  pendingSuggestions.delete(suggestionId);
  for (const [id, item] of pendingSuggestions) if (affectedIds.includes(item.appointmentId)) pendingSuggestions.delete(id);
  const adjustment: GateAdjustment = { id: `ADJ-${sequence++}`, suggestionId, kind: suggestion.kind, actor, reason: suggestion.reason, at: new Date().toISOString(), appointmentIds: affectedIds, before, after };
  gateAdjustments.unshift(adjustment);
  auditEvents.unshift({ id: `AUD-${Date.now()}`, actor, action: 'GATE_SLOT_ADJUST', entity: 'appointment', entityId: affectedIds.join(','), at: adjustment.at, details: `${suggestion.kind}: ${suggestion.reason}` });
  return adjustment;
}
