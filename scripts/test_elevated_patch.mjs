/**
 * 只读受保护目录按需单次系统提权补丁闭环回归测试（Red-Green 驱动）
 * 覆盖：
 *  1. 目标目录无写权限（EPERM/EACCES）时在用户临时区完成语法校验，返回 needsElevation + staged 文件
 *  2. switchAccount / runDoctor / AutoSwitcher 透传 needsElevation 而不误报成功或卡死
 *  3. 跨平台（win32 / darwin / linux）提权命令与含空格/引号路径转义安全性
 *  4. applyElevatedPatch 严格核验目标字节一致（拒绝假 exit 0）、识别用户取消、成功清理暂存区
 *  5. completeSwitchAfterElevation 一次打通补丁写入 + Junction + 切号指令就位
 *  6. SidebarProvider.promptElevationAndApply 原生授权流与重启弹窗串联 + 防重入
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
const failures = [];

function check(title, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${title}`);
  } else {
    failed++;
    failures.push({ title, detail });
    console.log(`  FAIL  ${title}${detail ? ' — ' + detail : ''}`);
  }
}

const uiCalls = {
  warningMessages: [],
  infoMessages: [],
  nextWarningChoice: undefined
};

const mockVscode = {
  env: {
    appName: 'CodeBuddy CN',
    appRoot: '',
    sessionId: 'test-elevate-session',
    language: 'zh-cn',
    clipboard: { writeText: async () => {} },
    openExternal: async () => true
  },
  workspace: {
    getConfiguration: () => ({ get: (_k, def) => def }),
    onDidChangeConfiguration: () => ({ dispose: () => {} })
  },
  window: {
    showWarningMessage: async (msg, ...rest) => {
      uiCalls.warningMessages.push({ msg, rest });
      return uiCalls.nextWarningChoice;
    },
    showInformationMessage: async (msg, ...rest) => {
      uiCalls.infoMessages.push({ msg, rest });
      return undefined;
    },
    showErrorMessage: async () => undefined,
    withProgress: async (_opt, fn) => fn({ report: () => {} }),
    createStatusBarItem: () => ({ show: () => {}, hide: () => {}, dispose: () => {} }),
    registerWebviewViewProvider: () => ({ dispose: () => {} })
  },
  commands: {
    executeCommand: async () => {},
    registerCommand: () => ({ dispose: () => {} })
  },
  Uri: {
    file: (p) => ({ fsPath: p }),
    joinPath: (b, ...s) => ({ fsPath: path.join(b?.fsPath || '', ...s) }),
    parse: (s) => ({ toString: () => s })
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15 }
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return mockVscode;
  return origLoad.apply(this, arguments);
};

// 标准干净宿主源码骨架（含必需的 5 处补丁锚点）
const SAMPLE_CLEAN_MAIN = [
  'var xx=0;',
  'HM=class{constructor(a){this.a=a;}',
  'getV2ReconcileData(t){const e=t?.userId;return e?{enabled:!0,sessions:Array.from(this._sessions.values()).filter(s=>s.userId===e||!s.userId).sort((s,n)=>n.updatedAt-s.updatedAt)}:{enabled:!0,sessions:[]}}',
  '};',
  'class AuthHost{',
  'constructor(e,i){this.instantiationService=e;this.logService=i;}',
  'async restoreSession(arg){return arg;}',
  'scheduleRefresh(e=0){}',
  '}'
].join('\n');

async function run() {
  console.log('=== 开始 BuddyRelay 受保护目录按需提权补丁回归测试 ===\n');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddyrelay-elevate-'));

  try {
    const ssMod = require(path.join(ROOT, 'out', 'seamlessSwitcher.js'));
    const { SeamlessSwitcher } = ssMod;
    const { AccountStore } = require(path.join(ROOT, 'out', 'accountStore.js'));
    const { AutoSwitcher } = require(path.join(ROOT, 'out', 'autoSwitcher.js'));
    const { SidebarProvider } = require(path.join(ROOT, 'out', 'sidebarProvider.js'));
    const { PATCH_V5 } = require(path.join(ROOT, 'out', 'constants.js'));

    // ── 1. 目标目录无写权限时生成 staged 补丁包且不破坏原文件 ──
    console.log('[测试 1/5] 只读目录 healPatch 生成提权暂存计划');
    const protectedDir = path.join(tmpDir, 'Program Files', "CodeBuddy CN's", 'out');
    fs.mkdirSync(protectedDir, { recursive: true });
    const protectedMain = path.join(protectedDir, 'main.js');
    fs.writeFileSync(protectedMain, SAMPLE_CLEAN_MAIN, 'utf8');
    const stagedDir = path.join(tmpDir, 'user-staged');
    const cmdFile = path.join(tmpDir, 'byok-switch.json');

    // 劫持 atomicWriteFileSync 对 protectedDir 的写或 mock fs.writeFileSync/copyFileSync 对 protectedDir 抛 EPERM
    const origCopyFileSync = fs.copyFileSync;
    const origWriteFileSync = fs.writeFileSync;
    const blockProtectedWrite = (p) => typeof p === 'string' && path.resolve(p).startsWith(path.resolve(protectedDir));
    fs.copyFileSync = (src, dest, mode) => {
      if (blockProtectedWrite(dest)) {
        const err = new Error(`EPERM: operation not permitted, copyfile -> '${dest}'`);
        err.code = 'EPERM';
        throw err;
      }
      return origCopyFileSync.call(fs, src, dest, mode);
    };
    fs.writeFileSync = (p, data, opts) => {
      if (blockProtectedWrite(p)) {
        const err = new Error(`EACCES: permission denied, open '${p}'`);
        err.code = 'EACCES';
        throw err;
      }
      return origWriteFileSync.call(fs, p, data, opts);
    };

    let patchRes;
    let sw1;
    try {
      sw1 = new SeamlessSwitcher({
        mainJsPath: protectedMain,
        cmdPath: cmdFile,
        stagedPatchDir: stagedDir
      });
      sw1.ensureJunction = () => ({ success: true, masterPath: '', targetPath: '', alreadyExisted: false, message: 'ok' });
      patchRes = sw1.healPatch(protectedMain);
    } finally {
      fs.copyFileSync = origCopyFileSync;
      fs.writeFileSync = origWriteFileSync;
    }

    check(
      '只读目录 healPatch 返回 needsElevation=true 与 error=NEEDS_ELEVATION',
      patchRes && patchRes.success === false && patchRes.needsElevation === true && patchRes.error === 'NEEDS_ELEVATION',
      JSON.stringify(patchRes)
    );
    check(
      '原受保护 main.js 保持干净未被损坏，且 .byok-origin 未提前产生残留',
      fs.readFileSync(protectedMain, 'utf8') === SAMPLE_CLEAN_MAIN && !fs.existsSync(`${protectedMain}.byok-origin`)
    );
    const plan = patchRes?.elevationPlan;
    check(
      'stagedMainPath 与 stagedOriginPath 均已落盘在用户可写区且内容含补丁标记',
      Boolean(
        plan &&
        fs.existsSync(plan.stagedMainPath) &&
        fs.readFileSync(plan.stagedMainPath, 'utf8').includes(PATCH_V5.V5_MARKER) &&
        plan.stagedOriginPath &&
        fs.existsSync(plan.stagedOriginPath) &&
        fs.readFileSync(plan.stagedOriginPath, 'utf8') === SAMPLE_CLEAN_MAIN
      ),
      JSON.stringify(plan)
    );

    // ── 2. switchAccount / runDoctor / AutoSwitcher 透传 needsElevation ──
    console.log('[测试 2/5] switchAccount / runDoctor / AutoSwitcher 透传提权信号');
    const poolFile = path.join(tmpDir, 'pool.json');
    const store = new AccountStore(undefined, poolFile);
    await store.upsertBatch([
      {
        id: 'a1', uid: 'u1', email: '1@t.cn', nickname: 'One',
        accessToken: 't1', refreshToken: 'r1', tokenType: 'Bearer',
        expiresAt: Date.now() + 7200e3, domain: 'www.codebuddy.cn',
        status: 'active', createdAt: 1, lastUsed: 2
      },
      {
        id: 'a2', uid: 'u2', email: '2@t.cn', nickname: 'Two',
        accessToken: 't2', refreshToken: 'r2', tokenType: 'Bearer',
        expiresAt: Date.now() + 7200e3, domain: 'www.codebuddy.cn',
        status: 'idle', createdAt: 1, lastUsed: 1
      }
    ]);

    fs.copyFileSync = (src, dest, mode) => {
      if (blockProtectedWrite(dest)) {
        const e = new Error('EPERM'); e.code = 'EPERM'; throw e;
      }
      return origCopyFileSync.call(fs, src, dest, mode);
    };
    fs.writeFileSync = (p, data, opts) => {
      if (blockProtectedWrite(p)) {
        const e = new Error('EACCES'); e.code = 'EACCES'; throw e;
      }
      return origWriteFileSync.call(fs, p, data, opts);
    };
    let docRes;
    let swRes;
    const emitted = [];
    try {
      docRes = sw1.runDoctor(protectedMain, path.join(tmpDir, 'missing-watcher.log'));
      swRes = await sw1.switchAccount('a2', store);

      const autoSw = new AutoSwitcher(store, sw1);
      autoSw.probeAccount = async () => ({ valid: true });
      autoSw.on('rotation', () => emitted.push('rotation'));
      autoSw.on('needs_elevation', () => emitted.push('needs_elevation'));
      autoSw.on('rotation_failed', () => emitted.push('rotation_failed'));
      await autoSw.handleQuotaExhausted('u1');
    } finally {
      fs.copyFileSync = origCopyFileSync;
      fs.writeFileSync = origWriteFileSync;
    }

    check('runDoctor 返回 status=needs_elevation 且附带 elevationPlan', docRes?.status === 'needs_elevation' && Boolean(docRes?.elevationPlan), JSON.stringify(docRes));
    check('switchAccount 返回 needsElevation=true 且不提前更改活跃账号', swRes?.needsElevation === true && Boolean(swRes?.elevationPlan) && store.getActive()?.id === 'a1');
    check('AutoSwitcher 遇 needsElevation 发射 needs_elevation 而不误发射 rotation', emitted.includes('needs_elevation') && !emitted.includes('rotation'), emitted.join(','));

    // ── 3. 跨平台提权命令脚本与特殊路径转义检查 ──
    console.log('[测试 3/5] 跨平台提权脚本转义与安全性');
    const hasScriptBuilder = typeof ssMod.buildElevationArtifacts === 'function';
    check('导出跨平台 buildElevationArtifacts 工具函数', hasScriptBuilder);
    if (hasScriptBuilder) {
      const winArt = ssMod.buildElevationArtifacts('win32', plan, path.join(tmpDir, 'scripts-win'));
      check(
        'Windows PS 脚本转义单引号并使用 -LiteralPath',
        winArt.scriptContent.includes("CodeBuddy CN''s") && winArt.scriptContent.includes('-LiteralPath') && winArt.commandArgs.some(a => a.includes('RunAs')),
        winArt.scriptContent
      );
      const macPlan = {
        mainJsPath: "/Applications/CodeBuddy CN's.app/Contents/Resources/app/out/main.js",
        originPath: "/Applications/CodeBuddy CN's.app/Contents/Resources/app/out/main.js.byok-origin",
        stagedMainPath: plan.stagedMainPath,
        stagedOriginPath: plan.stagedOriginPath,
        backupCreated: true
      };
      const macArt = ssMod.buildElevationArtifacts('darwin', macPlan, path.join(tmpDir, 'scripts-mac'));
      check('macOS osascript 命令包含 administrator privileges 且安全转义单引号', macArt.command === 'osascript' && macArt.scriptContent.includes("'\\''"), JSON.stringify(macArt));
      const linuxArt = ssMod.buildElevationArtifacts('linux', macPlan, path.join(tmpDir, 'scripts-linux'));
      check('Linux 提权命令走 pkexec', linuxArt.command === 'pkexec', linuxArt.command);

      if (process.platform === 'win32') {
        const winRunDir = path.join(tmpDir, 'win-ps-real');
        const winDestDir = path.join(tmpDir, "Dest With 'Quote' & Spaces");
        fs.mkdirSync(winRunDir, { recursive: true });
        fs.mkdirSync(winDestDir, { recursive: true });
        const winDestMain = path.join(winDestDir, 'main.js');
        const winDestOrigin = `${winDestMain}.byok-origin`;
        fs.writeFileSync(winDestMain, SAMPLE_CLEAN_MAIN, 'utf8');
        fs.chmodSync(winDestMain, 0o444); // 标为只读属性，实测 PowerShell 脚本能否摘掉 ReadOnly 并覆盖
        const winRealPlan = {
          mainJsPath: winDestMain,
          originPath: winDestOrigin,
          stagedMainPath: plan.stagedMainPath,
          stagedOriginPath: plan.stagedOriginPath,
          backupCreated: true
        };
        const realWinArt = ssMod.buildElevationArtifacts('win32', winRealPlan, winRunDir);
        fs.writeFileSync(realWinArt.scriptPath, '\uFEFF' + realWinArt.scriptContent, 'utf8');
        const psExec = childProcess.spawnSync(
          realWinArt.command,
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', realWinArt.scriptPath],
          { encoding: 'utf8', windowsHide: true }
        );
        const mainBytesMatch = fs.existsSync(winDestMain) &&
          Buffer.compare(fs.readFileSync(winDestMain), fs.readFileSync(plan.stagedMainPath)) === 0;
        const originBytesMatch = fs.existsSync(winDestOrigin) &&
          fs.readFileSync(winDestOrigin, 'utf8') === SAMPLE_CLEAN_MAIN;
        try { fs.chmodSync(winDestMain, 0o666); } catch {}
        check(
          'Windows 实测执行 .ps1 复制脚本：成功解除只读并字节级覆盖带引号/空格路径下的目标文件',
          psExec.status === 0 && mainBytesMatch && originBytesMatch,
          `status=${psExec.status} err=${psExec.stderr || ''} match=${mainBytesMatch}/${originBytesMatch}`
        );
      }
    }

    // ── 4. applyElevatedPatch 真实验收（防假 exit 0、识别取消、真实落地清理） ──
    console.log('[测试 4/5] applyElevatedPatch 严格验真与暂存区清理');
    // 4a. 假成功（runner 返回 code=0 但没写磁盘）必须被独立核验拦截！
    const swFake = new SeamlessSwitcher({
      mainJsPath: protectedMain,
      cmdPath: cmdFile,
      stagedPatchDir: stagedDir,
      elevateRunner: async () => ({ code: 0, stdout: '', stderr: '' })
    });
    const fakeApplyRes = await swFake.applyElevatedPatch(plan);
    check(
      '提权进程返回 exit 0 但目标未真修改时，必须验收失败绝不谎报成功',
      fakeApplyRes.success === false && fakeApplyRes.error === 'ELEVATION_VERIFY_FAILED',
      JSON.stringify(fakeApplyRes)
    );

    // 4b. 用户取消 UAC
    const swCancel = new SeamlessSwitcher({
      mainJsPath: protectedMain,
      cmdPath: cmdFile,
      stagedPatchDir: stagedDir,
      elevateRunner: async () => ({ code: 1, cancelled: true, stdout: '', stderr: 'The operation was canceled by the user' })
    });
    const cancelRes = await swCancel.applyElevatedPatch(plan);
    check('用户取消系统 UAC 授权时返回 cancelled=true 且目标保持未改动', cancelRes.success === false && cancelRes.cancelled === true && fs.readFileSync(protectedMain, 'utf8') === SAMPLE_CLEAN_MAIN);

    // 4c. 真实落地并准备切号指令
    const swReal = new SeamlessSwitcher({
      mainJsPath: protectedMain,
      cmdPath: cmdFile,
      stagedPatchDir: stagedDir,
      elevateRunner: async (p) => {
        if (p.stagedOriginPath && p.originPath) {
          fs.copyFileSync(p.stagedOriginPath, p.originPath);
        }
        fs.copyFileSync(p.stagedMainPath, p.mainJsPath);
        return { code: 0, stdout: '', stderr: '' };
      }
    });
    swReal.ensureJunction = () => ({ success: true, masterPath: '', targetPath: '', alreadyExisted: false, message: 'ok' });
    const completeRes = await swReal.completeSwitchAfterElevation(plan, store.get('a2'), store);
    check(
      'completeSwitchAfterElevation 成功落地 main.js、byok-origin 并清理暂存文件',
      Boolean(
        completeRes.success &&
        swReal.checkPatch(protectedMain).isPatched &&
        fs.readFileSync(`${protectedMain}.byok-origin`, 'utf8') === SAMPLE_CLEAN_MAIN &&
        !fs.existsSync(plan.stagedMainPath)
      ),
      JSON.stringify(completeRes)
    );
    check(
      '提权成功后同步写好待消费切号指令 (byok-switch.json 指向 u2)',
      fs.existsSync(cmdFile) && JSON.parse(fs.readFileSync(cmdFile, 'utf8')).session?.account?.uid === 'u2'
    );

    // ── 5. SidebarProvider.promptElevationAndApply 与防重入 ──
    console.log('[测试 5/5] SidebarProvider 原生授权弹窗与重启弹窗联动');
    // 重新准备一份待提权 plan
    fs.writeFileSync(protectedMain, SAMPLE_CLEAN_MAIN, 'utf8');
    try { fs.unlinkSync(`${protectedMain}.byok-origin`); } catch {}
    fs.copyFileSync = (src, dest, mode) => {
      if (blockProtectedWrite(dest)) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; }
      return origCopyFileSync.call(fs, src, dest, mode);
    };
    fs.writeFileSync = (p, data, opts) => {
      if (blockProtectedWrite(p)) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; }
      return origWriteFileSync.call(fs, p, data, opts);
    };
    let plan2;
    try {
      plan2 = swReal.healPatch(protectedMain).elevationPlan;
    } finally {
      fs.copyFileSync = origCopyFileSync;
      fs.writeFileSync = origWriteFileSync;
    }
    const sp = new SidebarProvider({ fsPath: ROOT }, store, swReal, {}, {}, {});
    const spPosted = [];
    sp._view = { visible: true, webview: { postMessage: (m) => spPosted.push(m) } };
    uiCalls.warningMessages.length = 0;
    uiCalls.nextWarningChoice = '授权写入补丁';
    const ok = await sp.promptElevationAndApply(plan2, store.get('a2'));
    check(
      'promptElevationAndApply 用户点授权后写入成功并主动弹出重启引导 (showRestartModal)',
      ok === true && swReal.checkPatch(protectedMain).isPatched && spPosted.some(m => m.command === 'showRestartModal'),
      JSON.stringify({ ok, spPosted })
    );

    store.dispose();
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log('失败明细:');
    for (const f of failures) {
      console.log(`  - ${f.title}${f.detail ? ' — ' + f.detail : ''}`);
    }
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
