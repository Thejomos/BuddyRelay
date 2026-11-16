/**
 * 切号稳定性、重启引导闭环与跨平台健壮性回归测试
 *
 * 覆盖：
 *  1. 隐藏侧栏（visible=false）时 promptFullRestart 走原生通知（带立即重启按钮），绝不吞弹窗
 *  2. AutoSwitcher 切号失败或 needsFullRestart 时绝不假发射 rotation、不提前篡改当前账号状态
 *  3. 重启后宿主消费重启前指令产生的回执能自动对齐 AccountStore 当前活跃号
 *  4. PATCH_V5 跨平台 dgw 路径与动态 session-master.json 读取（无硬编码作者 UID）
 *  5. 原子写模块并发无 0 字节 .tmp_ 残骸且能清理历史超龄临时文件
 *  6. package.json 声明 extensionKind: ["ui"]（Remote SSH 下强制本地宿主）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

// 拦截 require('vscode')，在纯 Node 下测试 SidebarProvider / extension 交互边界
const vscodeCalls = {
  infoMessages: [],
  executedCommands: [],
  nextInfoChoice: undefined
};
const mockVscode = {
  env: {
    appName: 'CodeBuddy CN',
    appRoot: '',
    sessionId: 'test-session-1234',
    language: 'zh-cn',
    clipboard: { writeText: async () => {} },
    openExternal: async () => true
  },
  workspace: {
    getConfiguration: () => ({
      get: (_k, def) => def
    }),
    onDidChangeConfiguration: () => ({ dispose: () => {} })
  },
  window: {
    showInformationMessage: async (msg, ...items) => {
      vscodeCalls.infoMessages.push({ msg, items });
      return vscodeCalls.nextInfoChoice;
    },
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    withProgress: async (_opt, fn) => fn({ report: () => {} }),
    createStatusBarItem: () => ({ show: () => {}, hide: () => {}, dispose: () => {} }),
    registerWebviewViewProvider: () => ({ dispose: () => {} })
  },
  commands: {
    executeCommand: async (cmd, ...args) => {
      vscodeCalls.executedCommands.push({ cmd, args });
    },
    registerCommand: () => ({ dispose: () => {} })
  },
  Uri: {
    file: (p) => ({ fsPath: p }),
    joinPath: (base, ...segs) => ({ fsPath: path.join(base?.fsPath || '', ...segs) }),
    parse: (s) => ({ toString: () => s })
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15 }
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return mockVscode;
  return origLoad.apply(this, arguments);
};

async function run() {
  console.log('=== 开始 BuddyRelay 切号健壮性与技术债回归测试 ===\n');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddyrelay-resilience-'));

  try {
    // ── 1. package.json Remote SSH UI 边界 ──
    console.log('[测试 1/6] package.json extensionKind 边界');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    check(
      'package.json 显式声明 extensionKind: ["ui"]',
      Array.isArray(pkg.extensionKind) && pkg.extensionKind.length === 1 && pkg.extensionKind[0] === 'ui',
      JSON.stringify(pkg.extensionKind)
    );

    // ── 2. 隐藏侧栏时 promptFullRestart 不得吞掉重启提示 ──
    console.log('[测试 2/6] 隐藏侧栏时不吞重启提示');
    const { AccountStore } = require(path.join(ROOT, 'out', 'accountStore.js'));
    const { SidebarProvider } = require(path.join(ROOT, 'out', 'sidebarProvider.js'));
    const { SeamlessSwitcher } = require(path.join(ROOT, 'out', 'seamlessSwitcher.js'));

    const poolPath = path.join(tmpDir, 'pool-sidebar.json');
    const store1 = new AccountStore(undefined, poolPath);
    const sp = new SidebarProvider(
      { fsPath: ROOT },
      store1,
      new SeamlessSwitcher(),
      {},
      {},
      {}
    );
    const postedToHiddenView = [];
    sp._view = {
      visible: false,
      webview: { postMessage: (m) => postedToHiddenView.push(m) }
    };
    vscodeCalls.infoMessages = [];
    vscodeCalls.executedCommands = [];
    vscodeCalls.nextInfoChoice = undefined;
    await sp.promptFullRestart();
    check(
      '侧栏隐藏时不得往不可见 webview 发 showRestartModal',
      !postedToHiddenView.some((m) => m && m.command === 'showRestartModal'),
      JSON.stringify(postedToHiddenView)
    );
    check(
      '侧栏隐藏时弹出原生信息通知且带立即重启按钮',
      vscodeCalls.infoMessages.length === 1 && vscodeCalls.infoMessages[0].items.length >= 1,
      JSON.stringify(vscodeCalls.infoMessages)
    );

    // 用户点击原生通知上的第一个动作（立即重启）应触发退出命令
    vscodeCalls.infoMessages = [];
    vscodeCalls.executedCommands = [];
    vscodeCalls.nextInfoChoice = '立即重启';
    await sp.promptFullRestart();
    check(
      '原生重启通知点击「立即重启」触发 workbench.action.quit',
      vscodeCalls.executedCommands.some((c) => c.cmd === 'workbench.action.quit'),
      JSON.stringify(vscodeCalls.executedCommands)
    );
    store1.dispose();

    // ── 3. AutoSwitcher 失败/需重启不得假发射 rotation ──
    console.log('[测试 3/6] AutoSwitcher 失败与 needsFullRestart 不误报成功');
    const { AutoSwitcher } = require(path.join(ROOT, 'out', 'autoSwitcher.js'));
    const poolPath2 = path.join(tmpDir, 'pool-auto.json');
    const store2 = new AccountStore(undefined, poolPath2);
    await store2.upsertBatch([
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
    await store2.setActive('a1');

    let stubOutcome = { success: false, needsFullRestart: true, message: 'need restart', error: 'NEEDS_FULL_RESTART' };
    const stubSwitcher = {
      switchAccount: async (target) => ({ ...stubOutcome, account: target })
    };
    const auto = new AutoSwitcher(store2, stubSwitcher);
    auto.probeAccount = async () => ({ valid: true });

    let rotationEmitted = 0;
    let needsRestartEmitted = 0;
    let failedEmitted = 0;
    auto.on('rotation', () => { rotationEmitted++; });
    auto.on('needs_restart', () => { needsRestartEmitted++; });
    auto.on('rotation_failed', () => { failedEmitted++; });

    await auto.handleQuotaExhausted('u1', 'low');
    check('额度切号遇 needsFullRestart 不发射 rotation', rotationEmitted === 0, `rotation=${rotationEmitted}`);
    check('额度切号遇 needsFullRestart 发射 needs_restart', needsRestartEmitted === 1, `needs_restart=${needsRestartEmitted}`);
    check('切号未成功时原活跃号仍维持 active', store2.get('a1')?.status === 'active', `status=${store2.get('a1')?.status}`);

    stubOutcome = { success: false, needsFullRestart: false, message: 'switch err', error: 'FAIL' };
    await auto.handleRateLimit429('u1', 60000, '429');
    check('429切号普通失败不发射 rotation', rotationEmitted === 0, `rotation=${rotationEmitted}`);
    check('429切号普通失败发射 rotation_failed', failedEmitted === 1, `failed=${failedEmitted}`);

    stubOutcome = { success: true, message: 'ok' };
    // 解除 a1 冷却状态以便测试正常切号（a2 本就 idle，以 a1 -> a2）
    await store2.setActive('a1');
    await auto.handleQuotaExhausted('u1', 'low');
    check('真实切号成功才发射 rotation', rotationEmitted === 1, `rotation=${rotationEmitted}`);
    store2.dispose();

    // ── 4. 重启消费待执行指令回执后对齐 AccountStore ──
    console.log('[测试 4/6] 重启消费指令回执对齐号池');
    const { PATHS } = require(path.join(ROOT, 'out', 'constants.js'));
    const savedCmd = PATHS.BYOK_SWITCH_FILE;
    const savedReceipt = PATHS.BYOK_SWITCH_RESULT_FILE;
    const recDir = path.join(tmpDir, 'reconcile');
    fs.mkdirSync(recDir, { recursive: true });
    PATHS.BYOK_SWITCH_FILE = path.join(recDir, 'byok-switch.json');
    PATHS.BYOK_SWITCH_RESULT_FILE = path.join(recDir, 'byok-switch-result.json');

    const store3 = new AccountStore(undefined, path.join(recDir, 'pool.json'));
    try {
      await store3.upsertBatch([
        {
          id: 'id-a', uid: 'uid-a', email: 'a@t.cn', nickname: 'A',
          accessToken: 't1', refreshToken: 'r1', tokenType: 'Bearer',
          expiresAt: Date.now() + 7200e3, domain: 'www.codebuddy.cn',
          status: 'active', createdAt: 1, lastUsed: 2
        },
        {
          id: 'id-b', uid: 'uid-b', email: 'b@t.cn', nickname: 'B',
          accessToken: 't2', refreshToken: 'r2', tokenType: 'Bearer',
          expiresAt: Date.now() + 7200e3, domain: 'www.codebuddy.cn',
          status: 'idle', createdAt: 1, lastUsed: 1
        }
      ]);
      await store3.setActive('id-a');
      const cmdTs = Date.now() - 5000;
      fs.writeFileSync(
        PATHS.BYOK_SWITCH_RESULT_FILE,
        JSON.stringify({ ok: true, uid: 'uid-b', ts: cmdTs }),
        'utf8'
      );
      const sw3 = new SeamlessSwitcher();
      const aligned = typeof sw3.reconcilePendingSwitch === 'function'
        ? await sw3.reconcilePendingSwitch(store3, cmdTs)
        : null;
      check('reconcilePendingSwitch 存在且返回对齐目标 uid-b', Boolean(aligned && aligned.uid === 'uid-b'), JSON.stringify(aligned));
      check('号池活跃账号已同步为 B', store3.getActive()?.uid === 'uid-b', String(store3.getActive()?.uid));
      check('已处理的历史回执被清理', !fs.existsSync(PATHS.BYOK_SWITCH_RESULT_FILE));
    } finally {
      PATHS.BYOK_SWITCH_FILE = savedCmd;
      PATHS.BYOK_SWITCH_RESULT_FILE = savedReceipt;
      store3.dispose();
    }

    // ── 5. PATCH_V5 跨平台 dgw 与无硬编码作者 UID（含沙盒实跑） ──
    console.log('[测试 5/6] PATCH_V5 跨平台 dgw 与动态母体读取');
    const { PATCH_V5 } = require(path.join(ROOT, 'out', 'constants.js'));
    check(
      'PATCH_V5.WATCHER_METHODS 不包含硬编码旧个人 UID',
      !PATCH_V5.WATCHER_METHODS.includes('69719899-bf05-4822-9e20-d4e7437a2edd')
    );
    check(
      'PATCH_V5.WATCHER_METHODS dgw 使用 __byokDir("data") 而非仅 Windows APPDATA',
      !PATCH_V5.WATCHER_METHODS.includes('process.env.APPDATA||""') &&
      PATCH_V5.WATCHER_METHODS.includes('__byokDir("data")')
    );
    check(
      'PATCH_V5.__ensureJunction 从 session-master.json 动态读取 masterUid',
      PATCH_V5.WATCHER_METHODS.includes('session-master.json')
    );

    // 运行期实测注入体内的 __byokReceipt 与 __ensureJunction 行为
    const patchRuntimeDir = path.join(tmpDir, 'patch-runtime');
    const fakeExtData = path.join(patchRuntimeDir, 'ext', 'CodeBuddyExtension', 'Data');
    const fakeMaster = path.join(fakeExtData, 'master-uid-1', 'CodeBuddyIDE', 'master-uid-1');
    const fakeRelayDir = path.join(patchRuntimeDir, 'data', 'CodeBuddy CN', 'buddy-relay');
    fs.mkdirSync(fakeMaster, { recursive: true });
    fs.writeFileSync(path.join(fakeMaster, 'history.json'), '{}', 'utf8');
    fs.mkdirSync(fakeRelayDir, { recursive: true });
    const HostClass = new Function(
      `return class FakeAuth { ${PATCH_V5.WATCHER_METHODS} constructor() { this.logs = []; this.logService = { info: (m) => this.logs.push(m) }; } __byokDir(k) { return k === 'data' ? ${JSON.stringify(path.join(patchRuntimeDir, 'data'))} : ${JSON.stringify(path.join(patchRuntimeDir, 'ext'))}; } }`
    )();
    globalThis.__byokFs = fs;
    globalThis.__byokPath = path;
    try {
      const hostInst = new HostClass();
      // 未写 session-master.json 时安全跳过，绝不乱建目录
      hostInst.__ensureJunction('target-uid-2');
      check(
        '无 session-master.json 时 __ensureJunction 安全跳过且记录原因',
        !fs.existsSync(path.join(fakeExtData, 'target-uid-2')) &&
        hostInst.logs.some((l) => l.includes('master uid not registered'))
      );
      // 写入 session-master.json 后再尝试，即使不真做 symlink 也应走到读取注册母体（Windows junction / POSIX dir）
      fs.writeFileSync(path.join(fakeRelayDir, 'session-master.json'), JSON.stringify({ masterUid: 'master-uid-1' }), 'utf8');
      hostInst.__ensureJunction('target-uid-2');
      const targetDir = path.join(fakeExtData, 'target-uid-2', 'CodeBuddyIDE', 'target-uid-2');
      check(
        '写入 session-master.json 后 __ensureJunction 正确联结到真实母体',
        fs.existsSync(targetDir) && fs.lstatSync(targetDir).isSymbolicLink()
      );
      hostInst.__byokReceipt({ ok: true, uid: 'target-uid-2', ts: 987654 });
      const receiptPath = path.join(patchRuntimeDir, 'data', 'CodeBuddy CN', 'byok-switch-result.json');
      check(
        '__byokReceipt 正确写出并原子重命名回执文件',
        fs.existsSync(receiptPath) && JSON.parse(fs.readFileSync(receiptPath, 'utf8')).uid === 'target-uid-2'
      );
    } finally {
      delete globalThis.__byokFs;
      delete globalThis.__byokPath;
    }

    // ── 6. atomicWrite 并发写零残骸与超龄清理 ──
    console.log('[测试 6/6] atomicWrite 并发零残骸与超龄临时文件清理');
    const atomicPath = path.join(ROOT, 'out', 'atomicWrite.js');
    const hasAtomic = fs.existsSync(atomicPath);
    check('atomicWrite 模块存在', hasAtomic);
    if (hasAtomic) {
      const { atomicWriteFileSync, cleanStaleTempFiles } = require(atomicPath);
      const awDir = path.join(tmpDir, 'aw');
      fs.mkdirSync(awDir, { recursive: true });
      const target = path.join(awDir, 'pool.json');
      for (let i = 0; i < 40; i++) {
        atomicWriteFileSync(target, JSON.stringify({ n: i }));
      }
      const leftover = fs.readdirSync(awDir).filter((f) => f.includes('.tmp_'));
      check('40次高频原子写后无 .tmp_ 残留', leftover.length === 0, leftover.join(','));
      check('最终落盘内容完整可解析', JSON.parse(fs.readFileSync(target, 'utf8')).n === 39);

      const staleTmp = path.join(awDir, 'pool.json.tmp_999_1');
      const freshTmp = path.join(awDir, 'pool.json.tmp_999_2');
      fs.writeFileSync(staleTmp, '', 'utf8');
      fs.writeFileSync(freshTmp, '', 'utf8');
      const past = new Date(Date.now() - 20 * 60 * 1000);
      fs.utimesSync(staleTmp, past, past);
      cleanStaleTempFiles(awDir, 'pool.json', 10 * 60 * 1000);
      check('过期 0 字节 .tmp_ 已被清理', !fs.existsSync(staleTmp));
      check('刚创建的活跃 .tmp_ 未被误删', fs.existsSync(freshTmp));
    }
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

