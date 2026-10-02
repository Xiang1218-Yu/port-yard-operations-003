import type { AppointmentStatus, Container, GateAppointment } from './domain.js';

/** 闸口时隙编排的纯领域内核：时间槽、车道容量、冲突检测、台账存储均放在此文件，
 *  不直接依赖可变的 domain 数组，便于在“确认建议”时基于实时数据重放校验。 */

export type Lane = 'north' | 'south' | 'rail';

export const SLOT_MINUTES = 30;
export const SLOT_MS = SLOT_MINUTES * 60 * 1000;
/** 同一辆车完成“交箱 → 提箱”两段作业之间的最小周转间隔 */
export const TURNAROUND_MINUTES = 15;
/** 每个 30 分钟时隙各车道可同时处理的预约数 */
export const LANE_CAPACITY: Record<Lane, number> = { north: 2, south: 2, rail: 1 };
export const LANES: Lane[] = ['north', 'south', 'rail'];

export type ConflictKind = 'truck-overlap' | 'lane-over-capacity' | 'customs-pickup-blocked' | 'cross-midnight';

export interface GateConflict {
  id: string;
  kind: ConflictKind;
  severity: 'critical' | 'warning';
  appointmentIds: string[];
  lane?: Lane;
  slotStart?: string;
  reason: string;
}

/** 参与时隙调整的预约字段快照，移动/换道/异常前后都按该结构留痕 */
export interface WindowSpec {
  windowStart: string;
  windowEnd: string;
  lane: Lane;
  status: AppointmentStatus;
  exception?: string;
}

export interface AppointmentChange {
  appointmentId: string;
  before: WindowSpec;
  after: WindowSpec;
  /** 建议生成时预约的版本号，确认时用于乐观锁比对 */
  expectedVersion: number;
}

export type SuggestionKind = 'move-window' | 'change-lane' | 'split-processing' | 'manual-exception';

export interface ScheduleSuggestion {
  id: string;
  kind: SuggestionKind;
  title: string;
  reasons: string[];
  conflictIds: string[];
  targetAppointmentId: string;
  feasible: boolean;
  blockedReason?: string;
  changes: AppointmentChange[];
  expectedVersions: Record<string, number>;
  createdAt: string;
}

export interface LaneLoad {
  slotStart: string;
  lanes: Record<Lane, { load: number; capacity: number }>;
}

export interface SchedulePlan {
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  slotMinutes: number;
  laneCapacity: Record<Lane, number>;
  conflicts: GateConflict[];
  suggestions: ScheduleSuggestion[];
  laneLoads: LaneLoad[];
}

export interface ReplanChange {
  appointmentId: string;
  before: WindowSpec;
  after: WindowSpec;
  versionBefore: number;
  versionAfter: number;
}

export interface ReplanRecord {
  id: string;
  at: string;
  actor: string;
  suggestionId: string;
  suggestionKind: SuggestionKind;
  note?: string;
  reasons: string[];
  changes: ReplanChange[];
  conflictIdsBefore: string[];
  conflictIdsAfter: string[];
}

export interface ReleasedSlot {
  appointmentId: string;
  truckNo: string;
  lane: Lane;
  slotStarts: string[];
  releasedAt: string;
  reason: 'cancelled' | 'deleted' | 'replan';
}

const ACTIVE_STATUSES: AppointmentStatus[] = ['booked', 'checked-in', 'exception'];
export const isActive = (a: GateAppointment) => ACTIVE_STATUSES.includes(a.status);
export const slotFloor = (t: number) => Math.floor(t / SLOT_MS) * SLOT_MS;
/** 窗口 [start, end) 覆盖到的全部 30 分钟时隙起点（半开区间） */
export function coveredSlots(startIso: string, endIso: string): number[] {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  const out: number[] = [];
  for (let t = slotFloor(start); t < end; t += SLOT_MS) out.push(t);
  return out;
}
export const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;
export const utcDay = (iso: string) => new Date(iso).toISOString().slice(0, 10);
export const crossesMidnight = (startIso: string, endIso: string) => utcDay(startIso) !== utcDay(endIso);
export const nextUtcMidnight = (t: number) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

const slotLabel = (iso: string) => {
  const t = new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60000;
  return new Date(t).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

/** 冲突检测：同车时间重叠、车道时隙超容、海关未放行的提箱预约、跨日窗口。
 *  车道容量类冲突只统计给定时间窗内的时隙，其余冲突不受时间窗限制。 */
export function analyzeConflicts(
  appts: GateAppointment[],
  containers: Container[],
  bounds?: { start: number; end: number },
): GateConflict[] {
  const active = appts.filter(isActive);
  const result: GateConflict[] = [];

  active.forEach((a, i) => {
    active.slice(i + 1).forEach(b => {
      if (a.truckNo !== b.truckNo) return;
      if (!overlaps(new Date(a.windowStart).getTime(), new Date(a.windowEnd).getTime(), new Date(b.windowStart).getTime(), new Date(b.windowEnd).getTime())) return;
      const ids = [a.id, b.id].sort();
      result.push({
        id: `CF-TRUCK-${ids.join('-')}`, kind: 'truck-overlap', severity: 'critical', appointmentIds: ids,
        reason: `车辆 ${a.truckNo} 的 ${a.id}（${a.lane}）与 ${b.id}（${b.lane}）时间窗口重叠，同一车辆无法同时在两条作业线上处理`,
      });
    });
  });

  const capacitySlots = new Map<string, { lane: Lane; slot: number; ids: string[] }>();
  active.forEach(a => {
    coveredSlots(a.windowStart, a.windowEnd).forEach(slot => {
      if (bounds && (slot < bounds.start || slot >= bounds.end)) return;
      const key = `${a.lane}@${slot}`;
      const entry = capacitySlots.get(key) ?? { lane: a.lane, slot, ids: [] };
      entry.ids.push(a.id);
      capacitySlots.set(key, entry);
    });
  });
  capacitySlots.forEach(entry => {
    if (entry.ids.length <= LANE_CAPACITY[entry.lane]) return;
    const ids = entry.ids.sort();
    result.push({
      id: `CF-CAP-${entry.lane}-${entry.slot}`, kind: 'lane-over-capacity', severity: 'critical',
      appointmentIds: ids, lane: entry.lane, slotStart: new Date(entry.slot).toISOString(),
      reason: `${slotLabel(new Date(entry.slot).toISOString())} 时段 ${laneLabel(entry.lane)}容量 ${LANE_CAPACITY[entry.lane]} 车，当前排队 ${entry.ids.length} 车（${ids.join('、')}）`,
    });
  });

  active.filter(a => a.status === 'booked').forEach(a => {
    const container = containers.find(c => c.id === a.containerId);
    if (a.type === 'pickup' && container && container.customs !== 'released') {
      result.push({
        id: `CF-CUSTOMS-${a.id}`, kind: 'customs-pickup-blocked', severity: 'warning', appointmentIds: [a.id], lane: a.lane,
        reason: `箱 ${a.containerId} 海关状态为 ${customsLabel(container.customs)}，提箱预约 ${a.id} 不能按时隙自动放行，需转人工异常处理`,
      });
    }
    if (crossesMidnight(a.windowStart, a.windowEnd)) {
      result.push({
        id: `CF-MIDNIGHT-${a.id}`, kind: 'cross-midnight', severity: 'warning', appointmentIds: [a.id], lane: a.lane,
        reason: `预约 ${a.id} 窗口 ${slotLabel(a.windowStart)} → ${slotLabel(a.windowEnd)} 跨日，跨日窗口不计入同一排班日的车道配额与夜间值守安排`,
      });
    }
  });

  return result.sort((x, y) => x.id.localeCompare(y.id));
}

export function laneLabel(lane: Lane) {
  return lane === 'north' ? '北闸口' : lane === 'south' ? '南闸口' : '铁路闸口';
}
export function customsLabel(status: Container['customs']) {
  return status === 'released' ? '已放行' : status === 'inspection' ? '查验中' : '扣留';
}

/** ---- 释放时隙台账：取消 / 删除 / 改单移动后，原时隙立即可被其他预约占用 ---- */
const releases: ReleasedSlot[] = [];
export function recordRelease(entry: Omit<ReleasedSlot, 'releasedAt'>) {
  releases.unshift({ ...entry, releasedAt: new Date().toISOString() });
  if (releases.length > 100) releases.length = 100;
}
export function recentReleases(limit = 20) {
  return releases.slice(0, limit).map(r => ({ ...r, slotStarts: [...r.slotStarts] }));
}

/** ---- 已确认改单的前后差异历史 ---- */
const replanHistory: ReplanRecord[] = [];
export function pushReplan(record: ReplanRecord) {
  replanHistory.unshift(record);
  if (replanHistory.length > 100) replanHistory.length = 100;
}
export function getReplanHistory(limit = 20): ReplanRecord[] {
  return replanHistory.slice(0, limit);
}
