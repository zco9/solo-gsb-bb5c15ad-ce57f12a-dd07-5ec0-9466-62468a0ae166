'use strict';

/**
 * 人员交接忙时排查引擎（只读，即时重放，不改写交接记录与签收）。
 *
 * 输入「人员、起止分钟、窗口长度、交接次数上限」，对起止范围内的每个整数
 * 起点 s（起始分钟 ≤ s ≤ 结束分钟，起止均含）取半开滑动窗口
 * [s, s + 窗口长度)，统计该人员在窗口内作为交出者或接收者参与的交接次数：
 *
 * - 逐件沿现有「同分钟唯一交接链」重放：只取最后一个窗口覆盖分钟（含）
 *   以前的记录（更晚的记录与冲突不参与）；同分钟链式交接按实际可接续记录
 *   逐条计数（如 仓库→张三、张三→李四 同分钟各计一次），与录入顺序无关。
 * - 冲突前已确认的记录继续计入：链上记录（冲突分钟之前的已确认前缀）
 *   照常计入已知次数；冲突分钟及以后的记录不计入已知，也不当作零。
 * - 窗口末端到达冲突分钟及以后（窗口覆盖冲突分钟或更晚，即 s+窗口长度 > 冲突分钟）
 *   时该窗口受冲突影响：已知次数超过上限仍判「确定超限」（未知不会使
 *   已超的次数变少），否则标为「无法判定」（不把冲突后的记录当作零）。
 * - 相邻同结论的窗口起点合并为起点段；返回已知峰值（各起点已知次数的
 *   最大值及达到峰值的起点段）、确定超限段涉及的记录与冲突道具清单。
 */

const { WAREHOUSE, sortRecords, replayPropRecords } = require('./verify');

/** 窗口结论类型 */
const WINDOW_STATUS = {
  OVER: 'OVER',             // 已知交接次数已超过上限：确定超限
  UNDETERMINED: 'UNDETERMINED', // 已知次数未超上限，但窗口伸入冲突分钟及以后：无法判定
  OK: 'OK',                 // 已知次数未超上限且无冲突触及：确定未超限
};

function recordCmp(a, b) {
  return (
    a.minute - b.minute ||
    String(a.propName).localeCompare(String(b.propName), 'zh') ||
    String(a.id).localeCompare(String(b.id))
  );
}

function conflictCmp(a, b) {
  return (
    a.conflictMinute - b.conflictMinute ||
    String(a.propName).localeCompare(String(b.propName), 'zh')
  );
}

/** 起点段展示用范围：单起点只写一个分钟 */
function startRangeText(seg) {
  return seg.firstStart === seg.lastStart
    ? `第${seg.firstStart}分`
    : `第${seg.firstStart}–${seg.lastStart}分`;
}

/**
 * 人员交接忙时排查。
 * @param {{props: Array, records: Array}} data 当前数据（只读）
 * @param {string} person 人员姓名（精确匹配）
 * @param {number} startMinute 起始分钟（含）：第一个窗口起点
 * @param {number} endMinute 结束分钟（含，须 >= startMinute）：最后一个窗口起点
 * @param {number} windowLength 窗口长度（>= 1）：窗口为半开区间 [s, s+windowLength)
 * @param {number} limit 交接次数上限（已知次数严格大于它才算超限）
 * @returns {object}
 */
function investigateBusyWindow(data, person, startMinute, endMinute, windowLength, limit) {
  const props = data.props || [];
  const records = data.records || [];

  // 最后一个窗口 [endMinute, endMinute+windowLength) 覆盖到的最大分钟；
  // 只重放该分钟（含）以前的记录，更晚的交接与冲突不影响本次排查
  const cutoffMinute = endMinute + windowLength - 1;

  // 逐件沿同分钟唯一交接链重放：链上记录即冲突前已确认的记录
  const confirmed = []; // 该人员参与的已确认链上记录（作为交出者或接收者）
  const conflicts = [];

  for (const prop of props) {
    const propRecords = sortRecords(
      records.filter((r) => r.propId === prop.id && Number(r.minute) <= cutoffMinute)
    );
    const replay = replayPropRecords(propRecords);

    for (const rec of replay.chain) {
      if (rec.from === person || rec.to === person) {
        confirmed.push({
          id: rec.id,
          propId: prop.id,
          propName: prop.name,
          minute: rec.minute,
          from: rec.from,
          to: rec.to,
          note: rec.note || '',
          role: rec.from === person ? 'from' : 'to', // from=交出 / to=接收
        });
      }
    }

    if (!replay.ok) {
      conflicts.push({
        propId: prop.id,
        propName: prop.name,
        conflictMinute: replay.conflict.minute,
        conflictType: replay.conflict.type,
        reason: replay.conflict.reason,
        conflictRecordIds: replay.conflict.records || [],
      });
    }
  }

  confirmed.sort(recordCmp);
  conflicts.sort(conflictCmp);

  // 逐整数起点求值：半开窗口 [s, s+windowLength)
  const windows = [];
  let peakCount = 0;
  for (let s = startMinute; s <= endMinute; s += 1) {
    const wEnd = s + windowLength; // 窗口末端（半开，不含）
    const knownCount = confirmed.reduce(
      (n, r) => n + (r.minute >= s && r.minute < wEnd ? 1 : 0),
      0
    );
    // 窗口末端到达冲突分钟及以后：窗口覆盖冲突分钟或更晚（s+窗口长度 > 冲突分钟）
    const reached = conflicts.filter((c) => c.conflictMinute < wEnd);
    const status =
      knownCount > limit
        ? WINDOW_STATUS.OVER
        : reached.length > 0
          ? WINDOW_STATUS.UNDETERMINED
          : WINDOW_STATUS.OK;
    if (knownCount > peakCount) peakCount = knownCount;
    windows.push({ start: s, end: wEnd, knownCount, status, reached });
  }

  // 合并相邻同结论窗口起点（起点逐分钟连续，同结论即并入同一段）
  const segments = [];
  for (const w of windows) {
    const last = segments[segments.length - 1];
    if (last && last.status === w.status) {
      last.lastStart = w.start;
      last.windows.push(w);
    } else {
      segments.push({ status: w.status, firstStart: w.start, lastStart: w.start, windows: [w] });
    }
  }

  const conflictBrief = (c) => ({
    propId: c.propId,
    propName: c.propName,
    conflictMinute: c.conflictMinute,
    conflictType: c.conflictType,
  });

  const overSegments = [];
  const undeterminedSegments = [];

  for (const seg of segments) {
    if (seg.status === WINDOW_STATUS.OK) continue;
    const segPeak = Math.max(...seg.windows.map((w) => w.knownCount));
    // 段内各窗口的并集覆盖分钟 [firstStart, lastStart+windowLength)
    const coverEnd = seg.lastStart + windowLength;
    // 段内触达的冲突道具并集（按冲突分钟、道具名排序）
    const reachedMap = new Map();
    for (const w of seg.windows) {
      for (const c of w.reached) reachedMap.set(c.propId, c);
    }
    const segConflicts = [...reachedMap.values()].map(conflictBrief).sort(conflictCmp);
    const conflictNames = segConflicts
      .map((c) => `「${c.propName}」自第${c.conflictMinute}分`)
      .join('、');

    if (seg.status === WINDOW_STATUS.OVER) {
      // 段内任一窗口计入的已确认记录并集 = 覆盖分钟范围内的全部已确认记录
      const segRecords = confirmed.filter(
        (r) => r.minute >= seg.firstStart && r.minute < coverEnd
      );
      overSegments.push({
        status: WINDOW_STATUS.OVER,
        firstStart: seg.firstStart,
        lastStart: seg.lastStart,
        coverEndMinute: coverEnd - 1, // 段内窗口并集覆盖到的最大分钟（含）
        peakKnownCount: segPeak,
        records: segRecords,
        conflicts: segConflicts,
        note:
          `窗口起点${startRangeText(seg)}的每个半开窗口内，已知确定交接次数均超过上限 ` +
          `${limit} 次（段内最高 ${segPeak} 次）` +
          (segConflicts.length
            ? `；另有 ${conflictNames} 起交接链冲突，冲突后的记录无法确认，实际次数可能更多`
            : '') +
          '。',
      });
    } else {
      undeterminedSegments.push({
        status: WINDOW_STATUS.UNDETERMINED,
        firstStart: seg.firstStart,
        lastStart: seg.lastStart,
        coverEndMinute: coverEnd - 1,
        maxKnownCount: segPeak,
        conflicts: segConflicts,
        note:
          `窗口起点${startRangeText(seg)}的半开窗口内，已知交接次数最高 ${segPeak} 次` +
          `（未超过上限 ${limit} 次），但 ${conflictNames} 起交接链冲突——` +
          '窗口末端到达冲突分钟及以后，冲突后的记录无法确认（不把冲突后的记录当作零），' +
          '无法判定是否超限。',
      });
    }
  }

  // 已知峰值：各起点已知次数的最大值，及达到峰值的相邻起点段
  const peakSegments = [];
  for (const w of windows) {
    if (w.knownCount !== peakCount) continue;
    const last = peakSegments[peakSegments.length - 1];
    if (last && last.lastStart === w.start - 1) {
      last.lastStart = w.start;
    } else {
      peakSegments.push({ firstStart: w.start, lastStart: w.start });
    }
  }

  // 涉及记录：确定超限段计入的已确认记录并集（按分钟、道具名、记录编号排序）
  const involvedMap = new Map();
  for (const seg of overSegments) {
    for (const r of seg.records) involvedMap.set(r.id, r);
  }
  const involvedRecords = [...involvedMap.values()].sort(recordCmp);

  return {
    person,
    startMinute,
    endMinute,
    windowLength,
    limit,
    warehouse: WAREHOUSE,
    overSegments,
    undeterminedSegments,
    peak: { count: peakCount, segments: peakSegments },
    involvedRecords,
    conflicts,
    summary: {
      totalProps: props.length,
      windowCount: windows.length,
      overSegmentCount: overSegments.length,
      undeterminedSegmentCount: undeterminedSegments.length,
      peakCount,
      involvedRecordCount: involvedRecords.length,
      conflictPropCount: conflicts.length,
      hasOver: overSegments.length > 0,
    },
  };
}

module.exports = { WINDOW_STATUS, investigateBusyWindow };
