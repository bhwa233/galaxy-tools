// Run with the selected Electron runtime after native + Electron compilation.
// This is one isolated production protocol/adapter chain, not the P1V matrix.
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const tar = require("tar");
const root = path.resolve(__dirname, "../..");
const compiledRoot =
  process.env.SPARK233_SEARCH_COMPILED_ROOT || path.join(root, "apps/desktop/dist-electron");
const run = path.join(root, "local-build/evidence/search-production", crypto.randomUUID());
fs.mkdirSync(run, { recursive: true });
app.setPath("userData", path.join(run, "electron-profile"));
const report = { run, checks: {}, serviceInstallationExecuted: false };
function check(name, condition) {
  report.checks[name] = !!condition;
  if (!condition) throw new Error(name);
}
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
app
  .whenReady()
  .then(async () => {
    const load = (name) =>
      import(pathToFileURL(path.join(compiledRoot, "electron/plugins", name + ".js")));
    const { PluginManager } = await load("manager");
    const { stageLocalPluginPackage } = await load("package-installer");
    const { resolvePluginEntries } = await load("manifest");
    const { createSearchRuntime } = await load("official/search");
    const files = path.join(run, "files");
    fs.mkdirSync(files, { recursive: true });
    fs.writeFileSync(
      path.join(files, "spark233-note.md"),
      "# spark233\n中文连续取字 English mixed.\n",
    );
    fs.writeFileSync(
      path.join(files, "spark233-worker.ts"),
      "export const marker = 'needle::code_symbols';\n",
    );
    fs.writeFileSync(path.join(files, "spark233-读我.txt"), "中文短词 needle::code_symbols\n");
    const privateRoot = path.join(files, "private");
    fs.mkdirSync(privateRoot);
    fs.writeFileSync(path.join(privateRoot, "spark233-hidden.md"), "中文 needle::code_symbols\n");
    fs.writeFileSync(path.join(files, "policy-visible.md"), "policy_boundary\n");
    fs.writeFileSync(path.join(files, "policy-visible.txt"), "policy_boundary\n");
    fs.writeFileSync(
      path.join(files, "policy-large.md"),
      "policy_boundary\n" + "x".repeat(2 * 1024 * 1024),
    );
    const hiddenFile = path.join(files, "policy-hidden.md"),
      hiddenDirectory = path.join(files, "hidden-directory");
    fs.writeFileSync(hiddenFile, "policy_boundary\n");
    fs.mkdirSync(hiddenDirectory);
    fs.writeFileSync(path.join(hiddenDirectory, "policy-child.md"), "policy_boundary\n");
    execFileSync("attrib.exe", ["+H", hiddenFile], { windowsHide: true });
    execFileSync("attrib.exe", ["+H", hiddenDirectory], { windowsHide: true });
    const token = crypto.randomUUID();
    const pipeName = "\\\\.\\pipe\\spark233Index.Test." + token;
    const binaries = path.join(root, "local-build/spark233/native-search/build/bin");
    const host = spawn(
      path.join(binaries, "spark233.Index.exe"),
      ["--test-host", token, files, path.join(run, "name-index")],
      {
        cwd: run,
        windowsHide: true,
        stdio: "pipe",
        env: {
          ...process.env,
          SPARK233_SEARCH_PROFILE_ROOT: path.join(run, "native-profile"),
          SPARK233_SEARCH_MACHINE_ROOT: path.join(run, "native-machine"),
          TEMP: run,
          TMP: run,
        },
      },
    );
    report.fixtureHostPid = host.pid;
    let stdout = "",
      stderr = "";
    host.stdout.on("data", (data) => {
      stdout += data;
    });
    host.stderr.on("data", (data) => {
      stderr += data;
    });
    const hostExit = new Promise((resolve) => host.once("close", (code) => resolve(code)));
    const paths = {
      stagingRoot: path.join(run, "staging"),
      versionsRoot: path.join(run, "versions"),
      cacheRoot: path.join(run, "package-cache"),
    };
    let manager;
    try {
      const work = path.join(run, "source");
      fs.mkdirSync(work, { recursive: true });
      fs.cpSync(path.join(root, "packages/official/search"), path.join(work, "package"), {
        recursive: true,
      });
      const archive = path.join(run, "search-0.1.0.tgz");
      await tar.c({ gzip: true, file: archive, cwd: work, portable: true }, ["package"]);
      const environment = {
        version: "1.2.0",
        apiVersion: "1.0.0",
        platform: process.platform,
        arch: process.arch,
      };
      const staged = await stageLocalPluginPackage(archive, environment, paths);
      report.packageIntegrity = staged.integrity;
      let beforePublish;
      const opened = [],
        revealed = [],
        copied = [];
      manager = new PluginManager({
        stateFile: path.join(run, "state.json"),
        dataRoot: path.join(run, "data"),
        backupRoot: path.join(run, "backups"),
        packages: paths,
        environment,
        createRuntime: async (installation, metadata, scope) => {
          const entries = resolvePluginEntries(installation.directory, metadata);
          return createSearchRuntime({
            scope,
            pluginRoot: installation.directory,
            descriptor: entries.native.search,
            dataDir: path.join(run, "data", installation.pluginId),
            cacheDir: path.join(run, "runtime-cache"),
            approveTrust: () => installation.grant.native,
            privateRoots: [privateRoot],
            openPath: async (filename) => {
              opened.push(filename);
            },
            revealPath: async (filename) => {
              revealed.push(filename);
            },
            copyPath: async (filename) => {
              copied.push(filename);
            },
            confirmServiceAction: async () => false,
            fixture: {
              pipeName,
              roots: [files],
              beforePublish: () => {
                const callback = beforePublish;
                beforePublish = undefined;
                callback?.();
              },
            },
          });
        },
      });
      await manager.initialize();
      await manager.install(
        staged,
        { capabilities: staged.metadata.spark233.capabilities, native: true },
        true,
      );
      const query = (commandId, query, limit = 60) =>
        manager.activate("spark233.search", { commandId, parameters: { query, limit } });
      // Private filename hits previously bypassed native exclusions; visible
      // paging must also count after filtering instead of leaving sparse pages.
      report.filename = await query("search", "spark233", 2);
      const first = report.filename.items.find((item) => item.commandId === "open");
      const next = report.filename.items.find((item) => item.commandId === "next-page");
      check(
        "filenamePageHasTwoVisibleHitsAndCursor",
        !!first &&
          !!next &&
          report.filename.items.length === 3 &&
          !report.filename.items.some((item) => item.title === "spark233-hidden.md"),
      );
      await manager.activate("spark233.search", {
        commandId: "open",
        parameters: first.parameters,
      });
      check(
        "opaqueSelectionOpensReturnedFixture",
        opened.length === 1 && opened[0].startsWith(files + path.sep),
      );
      report.serviceStatus = await manager.activate("spark233.search", {
        commandId: "service",
        parameters: { action: "status" },
      });
      await manager.activate("spark233.search", {
        commandId: "reveal",
        parameters: first.parameters,
      });
      await manager.activate("spark233.search", {
        commandId: "copy-path",
        parameters: first.parameters,
      });
      check(
        "statusKeepsOpaqueSelectionsAndActionsUseReturnedPath",
        report.serviceStatus.connected && revealed[0] === opened[0] && copied[0] === opened[0],
      );
      let rejected = false;
      try {
        await manager.activate("spark233.search", {
          commandId: "open",
          parameters: { selection: path.join(files, "spark233-note.md") },
        });
      } catch {
        rejected = true;
      }
      check("arbitraryOpenPathRejected", rejected);
      report.nextPage = await manager.activate("spark233.search", {
        commandId: "next-page",
        parameters: next.parameters,
      });
      check(
        "filenameNextPageContainsOnlyRemainingVisibleHit",
        report.nextPage.items.length === 1 &&
          report.nextPage.items[0].commandId === "open" &&
          report.nextPage.items[0].description !== first.description &&
          report.nextPage.items[0].title !== "spark233-hidden.md",
      );
      report.chinese = await query("content", "中文");
      check(
        "instantChineseHasTwoTextHits",
        report.chinese.items.filter((item) => item.commandId === "open").length === 2,
      );
      const contentHit = report.chinese.items.find((item) => item.commandId === "open");
      report.preview = await manager.activate("spark233.search", {
        commandId: "preview",
        parameters: contentHit.parameters,
      });
      check(
        "previewPreservesUnicodeAndMatchingLine",
        report.preview.searchPreview.line > 0 && report.preview.searchPreview.text.includes("中文"),
      );
      // The old bridge discarded read metadata and rebound old snippets to a
      // later path stat. Mutate a real file after native completion, before host publication.
      const versionedFile = path.join(files, "spark233-note.md");
      const originalBody = fs.readFileSync(versionedFile);
      beforePublish = () => fs.appendFileSync(versionedFile, "changed after read\n");
      const late = await query("content", "中文");
      check(
        "lateChangedContentIsNotPublished",
        !late.items.some((item) => item.title === "spark233-note.md"),
      );
      fs.writeFileSync(versionedFile, originalBody);
      const fresh = await query("content", "中文");
      const versionedHit = fresh.items.find((item) => item.title === "spark233-note.md");
      if (!versionedHit) throw new Error("Versioned fixture missing before replacement");
      const originalMetadata = fs.statSync(versionedFile, { bigint: true });
      const replacementPath = versionedFile + ".replacement",
        previous = versionedFile + ".previous";
      fs.writeFileSync(replacementPath, originalBody);
      execFileSync(
        "pwsh",
        [
          "-NoProfile",
          "-Command",
          `[IO.File]::SetLastWriteTimeUtc('${replacementPath.replaceAll("'", "''")}',[IO.File]::GetLastWriteTimeUtc('${versionedFile.replaceAll("'", "''")}'))`,
        ],
        { windowsHide: true },
      );
      fs.renameSync(versionedFile, previous);
      fs.renameSync(replacementPath, versionedFile);
      const replacementMetadata = fs.statSync(versionedFile, { bigint: true });
      const deniedPreview = await manager.activate("spark233.search", {
        commandId: "preview",
        parameters: versionedHit.parameters,
      });
      const openedBefore = opened.length;
      await manager.activate("spark233.search", {
        commandId: "open",
        parameters: versionedHit.parameters,
      });
      check(
        "sameSizeTimeReplacementIdentityIsRejected",
        originalMetadata.size === replacementMetadata.size &&
          originalMetadata.mtimeNs === replacementMetadata.mtimeNs &&
          originalMetadata.ino !== replacementMetadata.ino &&
          !deniedPreview.searchPreview &&
          opened.length === openedBefore,
      );
      fs.unlinkSync(versionedFile);
      fs.renameSync(previous, versionedFile);
      // Exercise the existing adapter/Instant permission boundary with a real
      // current-user DACL denial, confined to this new disposable fixture file.
      // Keep WRITE_DAC/metadata access so the saved DACL can always be restored.
      const aclDirectory = path.join(files, "acl-revocation");
      fs.mkdirSync(aclDirectory);
      const aclFile = path.join(aclDirectory, "revocable.md");
      const aclBody = "acl_revocation_boundary\n";
      fs.writeFileSync(aclFile, aclBody);
      const aclSnapshot = path.join(run, "acl-original.sddl");
      const aclEnvironment = {
        ...process.env,
        SPARK233_ACL_FIXTURE: aclFile,
        SPARK233_ACL_SNAPSHOT: aclSnapshot,
      };
      report.acl = { file: aclFile, snapshot: aclSnapshot };
      const beforeRevocation = await query("content", "acl_revocation_boundary");
      const revocableHit = beforeRevocation.items.find((item) => item.title === "revocable.md");
      if (!revocableHit) throw new Error("Readable ACL fixture was not returned");
      try {
        report.acl.applied = JSON.parse(
          execFileSync(
            "pwsh",
            [
              "-NoProfile",
              "-Command",
              "$ErrorActionPreference='Stop'; " +
                "$file=$env:SPARK233_ACL_FIXTURE; $acl=Get-Acl -LiteralPath $file; " +
                "$section=[Security.AccessControl.AccessControlSections]::Access; " +
                "[IO.File]::WriteAllText($env:SPARK233_ACL_SNAPSHOT,$acl.GetSecurityDescriptorSddlForm($section)); " +
                "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; " +
                "$deny=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::ReadData,[Security.AccessControl.AccessControlType]::Deny); " +
                "$acl.AddAccessRule($deny); Set-Acl -LiteralPath $file -AclObject $acl; " +
                "[pscustomobject]@{sid=$sid.Value;sddl=(Get-Acl -LiteralPath $file).GetSecurityDescriptorSddlForm($section)}|ConvertTo-Json -Compress",
            ],
            { windowsHide: true, env: aclEnvironment, encoding: "utf8" },
          ).trim(),
        );
        try {
          fs.readFileSync(aclFile);
        } catch (error) {
          report.acl.readError = error.code;
        }
        check(
          "actualAclRevocationDeniesCurrentCallerRead",
          ["EACCES", "EPERM"].includes(report.acl.readError),
        );
        let revokedPreview;
        try {
          revokedPreview = await manager.activate("spark233.search", {
            commandId: "preview",
            parameters: revocableHit.parameters,
          });
        } catch (error) {
          report.acl.previewError = error.message;
        }
        const openedBeforeRevokedAction = opened.length;
        try {
          await manager.activate("spark233.search", {
            commandId: "open",
            parameters: revocableHit.parameters,
          });
        } catch (error) {
          report.acl.openError = error.message;
        }
        check(
          "aclRevocationRejectsReturnedContentPreviewAndOpen",
          !revokedPreview?.searchPreview && opened.length === openedBeforeRevokedAction,
        );
        const afterRevocation = await query("content", "acl_revocation_boundary");
        check(
          "instantDoesNotReturnAclRevokedContent",
          !afterRevocation.items.some((item) => item.title === "revocable.md"),
        );
      } finally {
        if (fs.existsSync(aclSnapshot)) {
          report.acl.restoredDacl = execFileSync(
            "pwsh",
            [
              "-NoProfile",
              "-Command",
              "$ErrorActionPreference='Stop'; $file=$env:SPARK233_ACL_FIXTURE; " +
                "$acl=Get-Acl -LiteralPath $file; " +
                "$acl.SetSecurityDescriptorSddlForm([IO.File]::ReadAllText($env:SPARK233_ACL_SNAPSHOT),[Security.AccessControl.AccessControlSections]::Access); " +
                "Set-Acl -LiteralPath $file -AclObject $acl; " +
                "(Get-Acl -LiteralPath $file).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)",
            ],
            { windowsHide: true, env: aclEnvironment, encoding: "utf8" },
          ).trim();
          report.acl.restored =
            report.acl.restoredDacl === fs.readFileSync(aclSnapshot, "utf8") &&
            fs.readFileSync(aclFile, "utf8") === aclBody;
        }
        check("aclFixtureOriginalPermissionsRestored", report.acl.restored === true);
      }
      report.code = await query("content", "needle::code_symbols");
      check(
        "instantCodeHasTwoTextHits",
        report.code.items.filter((item) => item.commandId === "open").length === 2,
      );
      await manager.activate("spark233.search", {
        commandId: "settings",
        parameters: {
          action: "save",
          excludedRoots: [],
          extensions: ["md"],
          maxFileMiB: 1,
          includeHidden: false,
        },
      });
      report.policy = await query("content", "policy_boundary");
      check(
        "instantPolicyAdmitsOnlyRequestedTypeSizeAndVisibleFiles",
        report.policy.items.length === 1 && report.policy.items[0].title === "policy-visible.md",
      );
      await manager.activate("spark233.search", {
        commandId: "settings",
        parameters: {
          action: "save",
          excludedRoots: [],
          extensions: ["md"],
          maxFileMiB: 1,
          includeHidden: true,
        },
      });
      report.hiddenPolicy = await query("content", "policy_boundary");
      check(
        "hiddenPolicyIncludesHiddenFilesAndAncestorsWhenRequested",
        report.hiddenPolicy.items.length === 3,
      );
      await manager.activate("spark233.search", {
        commandId: "settings",
        parameters: {
          action: "save",
          excludedRoots: [],
          extensions: [],
          maxFileMiB: 64,
          includeHidden: false,
        },
      });
      report.defaultPolicy = await query("content", "policy_boundary");
      check("defaultPolicyRestoresAllowedTypesAndSize", report.defaultPolicy.items.length === 3);
      report.deniedConfiguration = await manager.activate("spark233.search", {
        commandId: "service",
        parameters: { action: "configure", excludedRoots: [privateRoot], volumeEnabled: [] },
      });
      check(
        "serviceConfigurationNeedsExplicitHostAuthorization",
        report.deniedConfiguration.status === "authorization-denied",
      );
      const old = query("content", "中文");
      const replacement = query("search", "spark233-worker");
      report.cancelledResult = await old;
      report.replacement = await replacement;
      check(
        "replacedQueryCannotPublishLateResult",
        report.cancelledResult === undefined &&
          report.replacement.items.some((item) => item.title === "spark233-worker.ts"),
      );
      report.declined = await manager.activate("spark233.search", { commandId: "install-service" });
      check(
        "declinedHostAuthorizationIsRetryable",
        report.declined.items[0].commandId === "install-service",
      );
      const stoppingQuery = query("content", "中文");
      await manager.setEnabled("spark233.search", false);
      await stoppingQuery;
      check(
        "disableCompletesAndClearsSessions",
        !manager.list()[0].enabled &&
          fs.readdirSync(path.join(run, "runtime-cache", "sessions")).length === 0,
      );
      await manager.shutdown();
      check(
        "noPersistentContentBodyDatabase",
        !findFiles(run).some((filename) => path.basename(filename) === "content-v1.sqlite"),
      );
      // Exercise ordinary production missing-service status without fixture routing;
      // no UAC, service install, fallback, or disk scan is requested.
      const missing = path.join(run, "missing-service");
      fs.mkdirSync(missing);
      fs.writeFileSync(
        path.join(missing, "request.json"),
        JSON.stringify({
          protocol: 1,
          sessionId: "missing-service",
          owner: { pluginId: "spark233.search", version: "0.1.0", instanceId: "isolated" },
          action: "search",
          mode: "files",
          query: "spark233",
          profile: path.join(run, "missing-profile"),
          offset: 0,
          limit: 10,
        }),
      );
      execFileSync(
        path.join(binaries, "spark233.Search.exe"),
        ["--request", path.join(missing, "request.json")],
        { windowsHide: true, timeout: 15000 },
      );
      report.missingService = JSON.parse(
        fs.readFileSync(path.join(missing, "result.json"), "utf8"),
      );
      check(
        "missingServiceClearAndRetryable",
        report.missingService.status === "service-not-installed",
      );
      execFileSync(path.join(binaries, "spark233_search_probe.exe"), ["shutdown", pipeName], {
        windowsHide: true,
        timeout: 15000,
      });
      check("fixtureHostExited", (await hostExit) === 0 && !processAlive(host.pid));
      report.ok = Object.values(report.checks).every(Boolean);
    } catch (error) {
      report.ok = false;
      report.error = error.stack;
    } finally {
      try {
        await manager?.shutdown();
      } catch (error) {
        report.cleanupError = error.stack;
      }
      if (processAlive(host.pid)) {
        try {
          execFileSync(path.join(binaries, "spark233_search_probe.exe"), ["shutdown", pipeName], {
            windowsHide: true,
            timeout: 15000,
          });
          await hostExit;
        } catch {
          host.kill();
          await hostExit;
        }
      }
      report.hostOutput = { stdout, stderr };
      fs.writeFileSync(path.join(run, "report.json"), JSON.stringify(report, null, 2));
      fs.writeFileSync(
        path.join(root, "local-build/evidence/search-production/report.json"),
        JSON.stringify(report, null, 2),
      );
      console.log(JSON.stringify(report, null, 2));
      app.exit(report.ok ? 0 : 1);
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
function findFiles(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? findFiles(path.join(directory, entry.name))
        : [path.join(directory, entry.name)],
    );
}
