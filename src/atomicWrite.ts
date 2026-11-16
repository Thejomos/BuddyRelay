import * as fs from 'fs';
import * as path from 'path';

let tmpSeq = 0;

/** 同步微等待：仅用于 Windows 下文件短锁（EPERM/EBUSY）重试 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // 极少数禁止 SharedArrayBuffer 环境的短退避兜底
    }
  }
}

function isTransientLockError(err: any): boolean {
  const code = String(err?.code || '');
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

export interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  /** Windows 下 rename 遇到持续锁占用时，是否允许降级直接覆写目标文件（默认 true） */
  allowDirectFallback?: boolean;
}

/**
 * 进程安全原子写：写入唯一临时文件（pid + 自增序号 + 随机盐）后 rename 替换目标。
 * 任何路径失败均确保清理临时文件，避免留下 0 字节 .tmp_ 残骸。
 */
export function atomicWriteFileSync(
  targetPath: string,
  content: string,
  options: AtomicWriteOptions = {}
): void {
  const encoding = options.encoding || 'utf8';
  const allowFallback = options.allowDirectFallback !== false;
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const nonce = Math.random().toString(36).slice(2, 8);
  const tmpPath = `${targetPath}.tmp_${process.pid}_${++tmpSeq}_${nonce}`;

  try {
    fs.writeFileSync(tmpPath, content, encoding);
    const backoffs = [0, 5, 15];
    let lastErr: any = null;
    for (const delay of backoffs) {
      if (delay > 0) sleepSync(delay);
      try {
        fs.renameSync(tmpPath, targetPath);
        return;
      } catch (err: any) {
        lastErr = err;
        if (!isTransientLockError(err)) {
          throw err;
        }
      }
    }

    if (allowFallback) {
      fs.writeFileSync(targetPath, content, encoding);
      return;
    }
    throw lastErr;
  } finally {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // 清理临时文件失败不覆盖主结果
    }
  }
}

/**
 * 清理指定目录下超龄的残留临时文件（如进程异常崩溃留下的 .tmp_* 0 字节文件）。
 * 只清理早于 maxAgeMs 的文件，避免误删其他窗口正在写入的临时文件。
 */
export function cleanStaleTempFiles(
  dir: string,
  targetBasename: string,
  maxAgeMs: number = 10 * 60 * 1000
): number {
  let removed = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    const cutoff = Date.now() - maxAgeMs;
    const prefixUnder = `${targetBasename}.tmp_`;
    const prefixDot = `${targetBasename}.tmp.`;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefixUnder) && !name.startsWith(prefixDot)) {
        continue;
      }
      const fullPath = path.join(dir, name);
      try {
        const st = fs.statSync(fullPath);
        if (st.isFile() && st.mtimeMs <= cutoff) {
          fs.unlinkSync(fullPath);
          removed++;
        }
      } catch {
        // 已被其他窗口清理或正被占用，跳过
      }
    }
  } catch {
    // 清理失败不影响主流程
  }
  return removed;
}

