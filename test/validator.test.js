import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildReport,
  evaluateTarget,
  listRecoveryPoints,
  restoreOrder,
  validateManifest,
} from '../src/validator.js';

/** 构造一条默认合法的备份记录。 */
function backup(overrides) {
  return {
    id: 'b',
    type: 'incremental',
    timestamp: '2026-11-01T00:00:00Z',
    parentId: null,
    logStart: 0,
    logEnd: 100,
    checksum: 'sha256:default',
    checksumVerified: true,
    fileIntact: true,
    fileSize: 1000,
    expectedSize: 1000,
    contentVersion: 1,
    baseVersion: null,
    replicas: [{ location: 'nas-a', available: true }],
    retention: 'retained',
    ...overrides,
  };
}

/** 完整链: full(0-100) -> inc(100-150) -> inc(150-220)。 */
function fullChain() {
  return [
    backup({
      id: 'full-1',
      type: 'full',
      timestamp: '2026-11-01T00:00:00Z',
      logStart: 0,
      logEnd: 100,
      checksum: 'sha256:full1',
      contentVersion: 1,
    }),
    backup({
      id: 'inc-1',
      timestamp: '2026-11-02T00:00:00Z',
      parentId: 'full-1',
      logStart: 100,
      logEnd: 150,
      checksum: 'sha256:inc1',
      contentVersion: 2,
      baseVersion: 1,
    }),
    backup({
      id: 'inc-2',
      timestamp: '2026-11-03T00:00:00Z',
      parentId: 'inc-1',
      logStart: 150,
      logEnd: 220,
      checksum: 'sha256:inc2',
      contentVersion: 3,
      baseVersion: 2,
    }),
  ];
}

describe('完整链', () => {
  it('全量+连续增量全部可用,恢复顺序正确', () => {
    const result = validateManifest({ backups: fullChain() });
    assert.deepEqual(result.unusable, []);
    assert.equal(result.usable.length, 3);

    const points = listRecoveryPoints(result);
    assert.deepEqual(
      points.find((p) => p.id === 'inc-2').restoreOrder.map((f) => f.file),
      ['full-1', 'inc-1', 'inc-2']
    );
  });

  it('差异备份挂在有效全量基线上可用', () => {
    const result = validateManifest({
      backups: [
        ...fullChain(),
        backup({
          id: 'diff-1',
          type: 'differential',
          timestamp: '2026-11-04T00:00:00Z',
          parentId: 'full-1',
          logStart: 100,
          logEnd: 300,
          checksum: 'sha256:diff1',
          contentVersion: 4,
          baseVersion: 1,
        }),
      ],
    });
    assert.ok(result.usable.some((r) => r.id === 'diff-1'));
  });
});

describe('缺父节点', () => {
  it('引用不存在的父备份时不可用并报告缺失节点', () => {
    const result = validateManifest({
      backups: [
        backup({ id: 'inc-x', parentId: 'ghost', logStart: 0, logEnd: 50 }),
      ],
    });
    assert.deepEqual(result.missingNodes, ['ghost']);
    const entry = result.unusable.find((u) => u.id === 'inc-x');
    assert.ok(entry.reasons.some((r) => r.startsWith('missing-parent:ghost')));
  });

  it('父备份损坏时增量链整体断裂', () => {
    const chain = fullChain();
    chain[1].fileIntact = false; // inc-1 上传中断
    const result = validateManifest({ backups: chain });
    const inc2 = result.unusable.find((u) => u.id === 'inc-2');
    assert.ok(inc2.reasons.some((r) => r === 'broken-ancestor:inc-1'));
  });
});

describe('日志缺口', () => {
  it('子备份起始日志与父备份结束日志不衔接时报告缺口', () => {
    const chain = fullChain();
    chain[2].logStart = 180; // 150..180 缺口
    const result = validateManifest({ backups: chain });
    const inc2 = result.unusable.find((u) => u.id === 'inc-2');
    assert.ok(
      inc2.reasons.some((r) => r.startsWith('log-chain-gap:expected-150-got-180'))
    );
  });

  it('目标时间点落在缺口内时不可恢复并给出最近可用点', () => {
    const chain = fullChain();
    chain[2].checksumVerified = false; // inc-2 损坏,覆盖 150..220
    const result = validateManifest({ backups: chain });
    const target = evaluateTarget(result, {
      name: 'pitr-1',
      time: '2026-11-03T12:00:00Z',
      logPosition: 200,
    });
    assert.equal(target.recoverable, false);
    assert.equal(target.reason, 'target-in-log-gap');
    assert.equal(target.nearestRecoveryPoint, 'inc-1');
    assert.equal(target.nearestLogPosition, 150);
    assert.deepEqual(target.blockedBy.map((b) => b.id), ['inc-2']);
  });
});

describe('分叉链', () => {
  it('同一父备份的多个子备份被识别为分叉', () => {
    const chain = fullChain();
    chain.push(
      backup({
        id: 'inc-2-fork',
        timestamp: '2026-11-03T06:00:00Z',
        parentId: 'inc-1',
        logStart: 150,
        logEnd: 210,
        checksum: 'sha256:inc2fork',
        contentVersion: 3,
        baseVersion: 2,
      })
    );
    const result = validateManifest({ backups: chain });
    assert.deepEqual(result.forks, [
      { parentId: 'inc-1', children: ['inc-2', 'inc-2-fork'] },
    ]);
    // 两个分支各自仍可作为恢复点
    assert.ok(result.usable.some((r) => r.id === 'inc-2-fork'));
  });
});

describe('重复备份', () => {
  it('相同摘要的备份被分组报告,取最早者为基准', () => {
    const chain = fullChain();
    chain.push(
      backup({
        id: 'inc-2-dup',
        timestamp: '2026-11-03T01:00:00Z',
        parentId: 'inc-1',
        logStart: 150,
        logEnd: 220,
        checksum: 'sha256:inc2',
        contentVersion: 3,
        baseVersion: 2,
      })
    );
    const result = validateManifest({ backups: chain });
    assert.deepEqual(result.duplicates, [
      { checksum: 'sha256:inc2', canonical: 'inc-2', duplicates: ['inc-2-dup'] },
    ]);
  });
});

describe('文件与内容异常', () => {
  it('文件大小异常不可用', () => {
    const result = validateManifest({
      backups: [backup({ id: 'full-1', type: 'full', fileSize: 900 })],
    });
    const entry = result.unusable.find((u) => u.id === 'full-1');
    assert.ok(entry.reasons.some((r) => r.startsWith('size-anomaly:900!=1000')));
  });

  it('校验通过但内容版本与父备份不一致', () => {
    const chain = fullChain();
    chain[1].baseVersion = 99; // 与 full-1 的 contentVersion=1 不符
    const result = validateManifest({ backups: chain });
    const inc1 = result.unusable.find((u) => u.id === 'inc-1');
    assert.ok(
      inc1.reasons.some((r) => r.startsWith('content-version-mismatch:base-99!=parent-1'))
    );
  });

  it('差异备份不能跨错误基线', () => {
    const chain = fullChain();
    chain[0].retention = 'expired'; // 基线全量已过保留期
    chain.push(
      backup({
        id: 'diff-1',
        type: 'differential',
        timestamp: '2026-11-04T00:00:00Z',
        parentId: 'full-1',
        logStart: 100,
        logEnd: 300,
        checksum: 'sha256:diff1',
        contentVersion: 4,
        baseVersion: 1,
      })
    );
    const result = validateManifest({ backups: chain });
    const diff = result.unusable.find((u) => u.id === 'diff-1');
    assert.ok(diff.reasons.includes('broken-baseline:full-1'));
  });

  it('差异备份的基线必须是全量备份', () => {
    const chain = fullChain();
    chain.push(
      backup({
        id: 'diff-bad',
        type: 'differential',
        timestamp: '2026-11-04T00:00:00Z',
        parentId: 'inc-1',
        logStart: 150,
        logEnd: 300,
        checksum: 'sha256:diffbad',
        contentVersion: 4,
        baseVersion: 2,
      })
    );
    const result = validateManifest({ backups: chain });
    const diff = result.unusable.find((u) => u.id === 'diff-bad');
    assert.ok(diff.reasons.includes('invalid-baseline:incremental'));
  });

  it('无可用副本与保留期过期均阻止恢复', () => {
    const result = validateManifest({
      backups: [
        backup({
          id: 'full-a',
          type: 'full',
          replicas: [{ location: 'nas-a', available: false }],
        }),
        backup({ id: 'full-b', type: 'full', retention: 'expired' }),
      ],
    });
    assert.ok(
      result.unusable.find((u) => u.id === 'full-a').reasons.includes('no-available-replica')
    );
    assert.ok(
      result.unusable.find((u) => u.id === 'full-b').reasons.includes('retention-expired')
    );
  });
});

describe('多个恢复时间点', () => {
  it('不同目标时间选择不同的可用恢复点', () => {
    const result = validateManifest({ backups: fullChain() });
    const t1 = evaluateTarget(result, { time: '2026-11-02T12:00:00Z' });
    const t2 = evaluateTarget(result, { time: '2026-11-05T00:00:00Z' });
    assert.equal(t1.recoveryPoint, 'inc-1');
    assert.equal(t2.recoveryPoint, 'inc-2');
    assert.deepEqual(
      t2.restoreOrder.map((f) => f.file),
      ['full-1', 'inc-1', 'inc-2']
    );
  });

  it('目标时间早于任何可用备份时不可恢复', () => {
    const result = validateManifest({ backups: fullChain() });
    const target = evaluateTarget(result, { time: '2026-10-01T00:00:00Z' });
    assert.equal(target.recoverable, false);
    assert.equal(target.reason, 'no-usable-recovery-point-before-target');
  });

  it('buildReport 汇总多个目标时间点', () => {
    const report = buildReport({
      backups: fullChain(),
      targets: [
        { name: 't-early', time: '2026-11-01T12:00:00Z', logPosition: 50 },
        { name: 't-late', time: '2026-11-03T12:00:00Z', logPosition: 200 },
        { name: 't-gap', time: '2026-11-03T12:00:00Z', logPosition: 999 },
      ],
    });
    assert.equal(report.targets.length, 3);
    assert.equal(report.targets[0].recoverable, true);
    assert.equal(report.targets[0].recoveryPoint, 'full-1');
    assert.equal(report.targets[1].recoverable, true);
    assert.equal(report.targets[1].recoveryPoint, 'inc-2');
    assert.equal(report.targets[2].recoverable, false);
    assert.equal(report.targets[2].reason, 'target-in-log-gap');
    assert.equal(report.recoveryPoints.length, 3);
  });
});

describe('restoreOrder', () => {
  it('返回从全量根到目标备份的文件顺序与副本位置', () => {
    const result = validateManifest({ backups: fullChain() });
    const order = restoreOrder(result, 'inc-2');
    assert.deepEqual(
      order.map((f) => f.file),
      ['full-1', 'inc-1', 'inc-2']
    );
    assert.ok(order.every((f) => f.location === 'nas-a'));
  });
});
