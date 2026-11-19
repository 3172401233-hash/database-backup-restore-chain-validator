/**
 * 备份恢复链验证器。
 *
 * 只读取备份清单(manifest)与摘要信息,不执行真实恢复。
 * 输入每条备份记录包含:类型、时间点、父备份、起始/结束日志位置、
 * 校验摘要、文件完整性、副本位置和保留状态。
 */

const VALID_TYPES = new Set(['full', 'incremental', 'differential']);

/**
 * @typedef {Object} BackupRecord
 * @property {string} id
 * @property {'full'|'incremental'|'differential'} type
 * @property {string} timestamp            ISO 8601 时间点
 * @property {string|null} parentId        父备份 id,全量备份为 null
 * @property {number} logStart             起始日志位置
 * @property {number} logEnd               结束日志位置
 * @property {string} checksum             校验摘要
 * @property {boolean} checksumVerified    摘要是否校验通过
 * @property {boolean} fileIntact          文件是否完整(上传中断为 false)
 * @property {number} fileSize             实际文件大小
 * @property {number} expectedSize         期望文件大小
 * @property {number} contentVersion       本备份内容版本
 * @property {number|null} baseVersion     构建时所基于的父备份内容版本
 * @property {{location:string, available:boolean}[]} replicas 副本位置
 * @property {'retained'|'expired'} retention 保留状态
 */

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/** 校验记录自身的字段级问题,返回原因列表(不依赖链)。 */
function selfProblems(record) {
  const reasons = [];
  if (!VALID_TYPES.has(record.type)) {
    reasons.push(`unknown-type:${record.type}`);
  }
  if (record.fileIntact === false) {
    reasons.push('file-incomplete'); // 上传中断,文件不完整
  }
  if (record.checksumVerified === false) {
    reasons.push('checksum-mismatch'); // 校验摘要不匹配
  }
  if (
    typeof record.fileSize === 'number' &&
    typeof record.expectedSize === 'number' &&
    record.fileSize !== record.expectedSize
  ) {
    reasons.push(`size-anomaly:${record.fileSize}!=${record.expectedSize}`);
  }
  const replicas = Array.isArray(record.replicas) ? record.replicas : [];
  if (!replicas.some((r) => r && r.available === true)) {
    reasons.push('no-available-replica');
  }
  if (record.retention === 'expired') {
    reasons.push('retention-expired');
  }
  if (
    typeof record.logStart === 'number' &&
    typeof record.logEnd === 'number' &&
    record.logStart > record.logEnd
  ) {
    reasons.push('log-range-inverted');
  }
  return reasons;
}

/**
 * 验证整个备份清单,计算每个备份是否可作为恢复点。
 *
 * @param {{backups: BackupRecord[]}} manifest
 */
export function validateManifest(manifest) {
  const records = Array.isArray(manifest?.backups) ? manifest.backups : [];
  const byId = new Map();
  const duplicateIds = [];

  for (const record of records) {
    if (!isNonEmptyString(record?.id)) continue;
    if (byId.has(record.id)) {
      duplicateIds.push(record.id); // 清单内 id 重复
      continue;
    }
    byId.set(record.id, record);
  }

  // 缺失节点:被引用但不存在的父备份
  const missingNodes = new Set();
  for (const record of byId.values()) {
    if (record.parentId != null && !byId.has(record.parentId)) {
      missingNodes.add(record.parentId);
    }
  }

  // 分叉链:同一父备份被多个子备份引用
  const childrenByParent = new Map();
  for (const record of byId.values()) {
    if (record.parentId == null) continue;
    if (!childrenByParent.has(record.parentId)) {
      childrenByParent.set(record.parentId, []);
    }
    childrenByParent.get(record.parentId).push(record.id);
  }
  const forks = [];
  for (const [parentId, children] of childrenByParent) {
    if (children.length > 1) {
      forks.push({ parentId, children: [...children].sort() });
    }
  }

  // 重复备份:摘要相同的记录分组(取时间最早者为基准)
  const byChecksum = new Map();
  for (const record of byId.values()) {
    if (!isNonEmptyString(record.checksum)) continue;
    if (!byChecksum.has(record.checksum)) {
      byChecksum.set(record.checksum, []);
    }
    byChecksum.get(record.checksum).push(record);
  }
  const duplicates = [];
  for (const [checksum, group] of byChecksum) {
    if (group.length < 2) continue;
    group.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    duplicates.push({
      checksum,
      canonical: group[0].id,
      duplicates: group.slice(1).map((r) => r.id),
    });
  }

  // 链式可用性:沿父链向上评估,带循环保护
  const reasonCache = new Map(); // id -> reasons[] (空数组表示可用)
  const evaluating = new Set();

  function chainProblems(record) {
    if (reasonCache.has(record.id)) return reasonCache.get(record.id);
    if (evaluating.has(record.id)) {
      return ['cycle-detected'];
    }
    evaluating.add(record.id);

    const reasons = [...selfProblems(record)];
    const parent = record.parentId != null ? byId.get(record.parentId) : null;

    if (record.type === 'full') {
      // 全量备份是链的根,不要求父节点
    } else if (record.parentId == null) {
      reasons.push('missing-parent:null');
    } else if (!parent) {
      reasons.push(`missing-parent:${record.parentId}`);
    } else {
      const parentReasons = chainProblems(parent);

      if (record.type === 'differential') {
        // 差异备份的基线必须是全量备份,且不能跨错误基线
        if (parent.type !== 'full') {
          reasons.push(`invalid-baseline:${parent.type}`);
        } else if (parentReasons.length > 0) {
          reasons.push(`broken-baseline:${parent.id}`);
        }
      } else if (record.type === 'incremental') {
        // 增量备份必须有连续可用的祖先链
        if (parentReasons.length > 0) {
          reasons.push(`broken-ancestor:${parent.id}`);
        }
      }

      // 日志链连续性:子备份起始日志必须衔接父备份结束日志
      if (
        (record.type === 'incremental' || record.type === 'differential') &&
        typeof record.logStart === 'number' &&
        typeof parent.logEnd === 'number' &&
        record.logStart !== parent.logEnd
      ) {
        reasons.push(`log-chain-gap:expected-${parent.logEnd}-got-${record.logStart}`);
      }

      // 校验通过但内容版本与父备份不一致
      if (
        record.checksumVerified !== false &&
        record.baseVersion != null &&
        parent.contentVersion != null &&
        record.baseVersion !== parent.contentVersion
      ) {
        reasons.push(
          `content-version-mismatch:base-${record.baseVersion}!=parent-${parent.contentVersion}`
        );
      }
    }

    evaluating.delete(record.id);
    reasonCache.set(record.id, reasons);
    return reasons;
  }

  const usable = [];
  const unusable = [];
  for (const record of byId.values()) {
    const reasons = chainProblems(record);
    if (reasons.length === 0) {
      usable.push(record);
    } else {
      unusable.push({ id: record.id, reasons });
    }
  }

  return {
    byId,
    usable,
    unusable,
    missingNodes: [...missingNodes].sort(),
    forks,
    duplicates,
    duplicateIds,
  };
}

/** 选取记录的第一个可用副本位置。 */
function pickReplica(record) {
  const replicas = Array.isArray(record.replicas) ? record.replicas : [];
  const replica = replicas.find((r) => r && r.available === true);
  return replica ? replica.location : null;
}

/**
 * 计算某个可用恢复点的恢复文件顺序(从全量根到该备份)。
 *
 * @returns {{file:string, location:string|null}[]} 按恢复应用顺序排列
 */
export function restoreOrder(result, backupId) {
  const chain = [];
  let current = result.byId.get(backupId);
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift({ file: current.id, location: pickReplica(current) });
    current = current.parentId != null ? result.byId.get(current.parentId) : null;
  }
  return chain;
}

/** 列出所有可用恢复点及其恢复文件顺序。 */
export function listRecoveryPoints(result) {
  return result.usable
    .slice()
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
    .map((record) => ({
      id: record.id,
      type: record.type,
      timestamp: record.timestamp,
      logStart: record.logStart,
      logEnd: record.logEnd,
      restoreOrder: restoreOrder(result, record.id),
    }));
}

/**
 * 评估指定时间点是否可恢复。
 *
 * 规则:取时间不晚于目标时间的最晚可用恢复点;
 * 若指定了目标日志位置,该恢复点的日志链必须覆盖到目标位置,
 * 否则判定目标落在日志缺口内。
 *
 * @param {{name?:string, time:string, logPosition?:number}} target
 */
export function evaluateTarget(result, target) {
  const candidates = result.usable
    .filter((r) => String(r.timestamp) <= String(target.time))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

  if (candidates.length === 0) {
    return {
      name: target.name ?? null,
      time: target.time,
      recoverable: false,
      reason: 'no-usable-recovery-point-before-target',
    };
  }

  const point = candidates[candidates.length - 1];

  if (typeof target.logPosition === 'number' && point.logEnd < target.logPosition) {
    // 目标日志位置落在缺口内:找出本可覆盖该位置但不可用的备份
    const blockers = result.unusable.filter((entry) => {
      const record = result.byId.get(entry.id);
      return (
        record &&
        typeof record.logStart === 'number' &&
        typeof record.logEnd === 'number' &&
        record.logStart <= target.logPosition &&
        target.logPosition <= record.logEnd
      );
    });
    return {
      name: target.name ?? null,
      time: target.time,
      recoverable: false,
      reason: 'target-in-log-gap',
      nearestRecoveryPoint: point.id,
      nearestLogPosition: point.logEnd,
      blockedBy: blockers.map((b) => ({ id: b.id, reasons: b.reasons })),
    };
  }

  return {
    name: target.name ?? null,
    time: target.time,
    recoverable: true,
    recoveryPoint: point.id,
    restoreOrder: restoreOrder(result, point.id),
  };
}

/** 生成完整验证报告。 */
export function buildReport(manifest) {
  const result = validateManifest(manifest);
  const targets = Array.isArray(manifest?.targets) ? manifest.targets : [];
  return {
    recoveryPoints: listRecoveryPoints(result),
    unusable: result.unusable.sort((a, b) => a.id.localeCompare(b.id)),
    missingNodes: result.missingNodes,
    forks: result.forks,
    duplicates: result.duplicates,
    duplicateIds: result.duplicateIds,
    targets: targets.map((t) => evaluateTarget(result, t)),
  };
}
