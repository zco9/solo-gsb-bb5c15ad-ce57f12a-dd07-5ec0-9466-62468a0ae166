'use strict';

/* 人员交接忙时排查接口集成测试：node test/busy-window-api.test.js
 * 使用独立临时数据文件，真实启动服务走 HTTP 全流程。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tmp-busy-window-api-store.json');
process.env.DATA_FILE = DATA_FILE;

for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
  try { fs.unlinkSync(f); } catch { /* 不存在则忽略 */ }
}

const app = require('../server');

let server;
let base;
let passed = 0;

async function api(url, options = {}) {
  const res = await fetch(`${base}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = res.status === 204 ? null : await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function main() {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  // 初始演示数据：
  // 青龙剑：仓库@0→张三@3→李四@8→张三@12→仓库（张三已确认分钟 0/3/8/12）
  // 折扇：仓库@1→张三，第5分多条可接续冲突（张三已确认分钟 1；第5分两条记录无法确认）
  // 宫灯：仓库@2→王五，第4分断链冲突（王五已确认分钟 2）
  // 御印：仓库@1→周八@6→孙七
  const state0 = (await api('/api/state')).body;
  const rev0 = state0.rev;
  const count0 = state0.records.length;

  // 1. 正常查询：超限段 / 无法判定段 / 峰值 / 涉及记录 / 冲突分组齐备
  await test('忙时排查：超限段 / 无法判定段 / 峰值 / 涉及记录 / 冲突完整返回', async () => {
    const res = await api('/api/busy-window?person=张三&start=0&end=12&window=3&limit=1');
    assert.strictEqual(res.status, 200);
    const r = res.body;
    assert.strictEqual(r.person, '张三');
    assert.strictEqual(r.startMinute, 0);
    assert.strictEqual(r.endMinute, 12);
    assert.strictEqual(r.windowLength, 3);
    assert.strictEqual(r.limit, 1);
    assert.strictEqual(r.warehouse, '仓库');

    // 起点 0、1 的窗口已知 2 次（青龙剑@0+折扇@1 / 折扇@1+青龙剑@3）：唯一确定超限段
    assert.strictEqual(r.overSegments.length, 1);
    const seg = r.overSegments[0];
    assert.strictEqual(seg.firstStart, 0);
    assert.strictEqual(seg.lastStart, 1);
    assert.strictEqual(seg.coverEndMinute, 3);
    assert.strictEqual(seg.peakKnownCount, 2);
    assert.strictEqual(seg.conflicts.length, 0);
    // 段内窗口并集覆盖第 0–3 分：涉及记录为青龙剑@0、折扇@1、青龙剑@3
    assert.deepStrictEqual(
      seg.records.map((x) => [x.propName, x.minute, x.role]),
      [['青龙剑', 0, 'to'], ['折扇', 1, 'to'], ['青龙剑', 3, 'from']]
    );

    // 起点 2–12 的窗口末端均到达冲突分钟（宫灯@4 / 折扇@5）及以后：一段无法判定
    assert.strictEqual(r.undeterminedSegments.length, 1);
    const u = r.undeterminedSegments[0];
    assert.strictEqual(u.firstStart, 2);
    assert.strictEqual(u.lastStart, 12);
    assert.strictEqual(u.maxKnownCount, 1);
    assert.deepStrictEqual(
      u.conflicts.map((c) => [c.propName, c.conflictMinute, c.conflictType]),
      [['宫灯', 4, 'BROKEN'], ['折扇', 5, 'AMBIGUOUS']]
    );

    // 已知峰值 2 次，出现于起点第 0–1 分；涉及记录为超限段并集
    assert.strictEqual(r.peak.count, 2);
    assert.deepStrictEqual(r.peak.segments, [{ firstStart: 0, lastStart: 1 }]);
    assert.strictEqual(r.involvedRecords.length, 3);

    // 冲突分组：宫灯第4分断链、折扇第5分歧义
    assert.deepStrictEqual(
      r.conflicts.map((c) => [c.propName, c.conflictMinute, c.conflictType]),
      [['宫灯', 4, 'BROKEN'], ['折扇', 5, 'AMBIGUOUS']]
    );
    assert.strictEqual(r.summary.hasOver, true);
    assert.strictEqual(r.summary.windowCount, 13);
    assert.strictEqual(r.summary.overSegmentCount, 1);
    assert.strictEqual(r.summary.undeterminedSegmentCount, 1);
    assert.strictEqual(r.summary.peakCount, 2);
    assert.strictEqual(r.summary.conflictPropCount, 2);
    assert.strictEqual(r.summary.involvedRecordCount, 3);
  });

  // 2. 等于上限不算超限：上限 2 时张三峰值 2 不超
  await test('忙时排查：已知次数等于上限不算超限', async () => {
    const r = (await api('/api/busy-window?person=张三&start=0&end=12&window=3&limit=2')).body;
    assert.strictEqual(r.overSegments.length, 0);
    assert.strictEqual(r.summary.hasOver, false);
    assert.strictEqual(r.peak.count, 2);
    // 窗口伸入冲突分钟及以后的起点段仍标为无法判定（不把冲突后的记录当作零）
    assert.strictEqual(r.undeterminedSegments.length, 1);
    assert.deepStrictEqual(
      [r.undeterminedSegments[0].firstStart, r.undeterminedSegments[0].lastStart],
      [2, 12]
    );
  });

  // 3. 窗口伸入冲突分钟及以后时，已知次数超上限仍判确定超限（段内标注冲突道具）
  await test('忙时排查：窗口伸入冲突后已知仍超上限 -> 确定超限并标注冲突', async () => {
    const r = (await api('/api/busy-window?person=张三&start=0&end=1&window=5&limit=1')).body;
    // s=0 [0,5)：青龙剑@0、折扇@1、青龙剑@3 = 3 次 > 1（触及宫灯@4）
    // s=1 [1,6)：折扇@1、青龙剑@3 = 2 次 > 1（触及宫灯@4、折扇@5）
    assert.strictEqual(r.overSegments.length, 1);
    const seg = r.overSegments[0];
    assert.deepStrictEqual([seg.firstStart, seg.lastStart, seg.peakKnownCount], [0, 1, 3]);
    assert.strictEqual(seg.records.length, 3);
    assert.deepStrictEqual(
      seg.conflicts.map((c) => [c.propName, c.conflictMinute]),
      [['宫灯', 4], ['折扇', 5]]
    );
    assert.strictEqual(r.undeterminedSegments.length, 0);
    assert.strictEqual(r.peak.count, 3);
  });

  // 4. 冲突后的记录不计入已知：王五在折扇第5分的记录无法确认，已知只计宫灯@2
  await test('忙时排查：冲突后的记录不计入已知也不当作零', async () => {
    const r = (await api('/api/busy-window?person=王五&start=0&end=6&window=2&limit=0')).body;
    // 王五已确认仅宫灯@2：s=1 [1,3)、s=2 [2,4) 各 1 次超限（确定）；
    // s=3..6 窗口伸入宫灯@4 / 折扇@5 冲突后，已知 0 次但不当作零 -> 无法判定
    assert.strictEqual(r.overSegments.length, 1);
    assert.deepStrictEqual(
      [r.overSegments[0].firstStart, r.overSegments[0].lastStart, r.overSegments[0].peakKnownCount],
      [1, 2, 1]
    );
    assert.deepStrictEqual(
      r.overSegments[0].records.map((x) => [x.propName, x.minute, x.role]),
      [['宫灯', 2, 'to']]
    );
    assert.strictEqual(r.undeterminedSegments.length, 1);
    assert.deepStrictEqual(
      [r.undeterminedSegments[0].firstStart, r.undeterminedSegments[0].lastStart],
      [3, 6]
    );
    assert.strictEqual(r.undeterminedSegments[0].maxKnownCount, 0);
    assert.strictEqual(r.peak.count, 1);
  });

  // 5. 窗口覆盖范围之外的更晚冲突不影响结果
  await test('忙时排查：窗口覆盖范围之外的更晚冲突不影响结果', async () => {
    // 最后一个窗口 [2,4)：只重放第 3 分钟及以前的记录，宫灯@4、折扇@5 的冲突不参与
    const r = (await api('/api/busy-window?person=张三&start=0&end=2&window=2&limit=0')).body;
    assert.strictEqual(r.conflicts.length, 0);
    assert.strictEqual(r.undeterminedSegments.length, 0);
    assert.strictEqual(r.overSegments.length, 1);
    assert.deepStrictEqual(
      [r.overSegments[0].firstStart, r.overSegments[0].lastStart, r.overSegments[0].peakKnownCount],
      [0, 2, 2]
    );
  });

  // 6. 只读：查询不改写数据（版本号与记录数不变）
  await test('忙时排查：查询只读，数据版本与记录数不变', async () => {
    await api('/api/busy-window?person=张三&start=0&end=12&window=3&limit=1');
    await api('/api/busy-window?person=仓库&start=0&end=30&window=5&limit=0');
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, rev0);
    assert.strictEqual(after.records.length, count0);
  });

  // 7. 参数校验：缺参数 / 负数 / 小数 / 起止颠倒 / 窗口长度不足 1 均 400
  await test('忙时排查：参数校验 400', async () => {
    let res = await api('/api/busy-window?start=0&end=12&window=3&limit=1');
    assert.strictEqual(res.status, 400);
    res = await api('/api/busy-window?person=张三&end=12&window=3&limit=1');
    assert.strictEqual(res.status, 400);
    res = await api('/api/busy-window?person=张三&start=0&window=3&limit=1');
    assert.strictEqual(res.status, 400);
    res = await api('/api/busy-window?person=张三&start=0&end=12&limit=1');
    assert.strictEqual(res.status, 400);
    assert.ok(/窗口长度/.test(res.body.error));
    res = await api('/api/busy-window?person=张三&start=0&end=12&window=3');
    assert.strictEqual(res.status, 400);
    assert.ok(/交接次数上限/.test(res.body.error));
    res = await api('/api/busy-window?person=张三&start=-1&end=12&window=3&limit=1');
    assert.strictEqual(res.status, 400);
    res = await api('/api/busy-window?person=张三&start=0&end=1.5&window=3&limit=1');
    assert.strictEqual(res.status, 400);
    res = await api('/api/busy-window?person=张三&start=5&end=3&window=3&limit=1');
    assert.strictEqual(res.status, 400);
    assert.ok(/起始分钟不能大于结束分钟/.test(res.body.error));
    res = await api('/api/busy-window?person=张三&start=0&end=12&window=0&limit=1');
    assert.strictEqual(res.status, 400);
    res = await api('/api/busy-window?person=张三&start=0&end=12&window=2.5&limit=1');
    assert.strictEqual(res.status, 400);
    res = await api('/api/busy-window?person=张三&start=0&end=12&window=3&limit=-2');
    assert.strictEqual(res.status, 400);
    res = await api('/api/busy-window?person=张三&start=0&end=12&window=3&limit=x');
    assert.strictEqual(res.status, 400);
  });

  server.close();
  for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
    try { fs.unlinkSync(f); } catch { /* 忽略 */ }
  }
  console.log(`\n全部 ${passed} 个交接忙时排查接口测试通过 ✔`);
}

main().catch((err) => {
  console.error(err);
  if (server) server.close();
  process.exit(1);
});
