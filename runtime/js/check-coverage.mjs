// Shared command-selection analysis. This proves only that argv selects the
// frozen test identifiers, never that assertions are sufficient or execution passed.
import path from 'node:path';
import {selectedNodeTestFiles} from './node-test-selection.mjs';

export const isXcodebuild = tokens => tokens.some(token => path.basename(token) === 'xcodebuild');
// xcodebuild options that take no value (xcodebuild -help, Xcode 26). A bare word counts as an
// action only right after xcodebuild, another bare word (an action or an option's value), an
// -option:value, or one of these. After any other option it may be that option's value
// (`-resultBundlePath test`), so it is not an action: an unknown flag then makes the coverage
// check warn instead of passing, never the other way round.
const XCODE_FLAGS = new Set(['-usage', '-help', '-verbose', '-license', '-checkFirstLaunchStatus', '-runFirstLaunch',
  '-checkForNewerComponents', '-downloadAllPlatforms', '-prepareDeviceSupport', '-alltargets', '-parallelizeTargets', '-quiet',
  '-hideShellScriptEnvironment', '-showsdks', '-showdestinations', '-showTestPlans', '-showBuildSettings', '-showBuildSettingsForIndex',
  '-list', '-version', '-exportArchive', '-exportNotarizedApp', '-skipUnavailableActions', '-exportLocalizations', '-importLocalizations',
  '-retry-tests-on-failure', '-run-tests-until-failure', '-disable-concurrent-destination-testing', '-enumerate-tests',
  '-resolvePackageDependencies', '-disableAutomaticPackageResolution', '-onlyUsePackageVersionsFromResolvedFile', '-skipPackageUpdates',
  '-disablePackageRepositoryCache', '-skipPackagePluginValidation', '-skipMacroValidation', '-skipPackageSignatureValidation', '-json',
  '-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration', '-showBuildTimingSummary']);
function xcodeActions(tokens) {
  const start = tokens.findIndex(token => path.basename(token) === 'xcodebuild');
  if (start === -1) return [];
  return tokens.slice(start + 1).filter((token, index, rest) => {
    if (token.startsWith('-')) return false;
    const before = index === 0 ? null : rest[index - 1];
    return before === null || !before.startsWith('-') || before.includes(':') || XCODE_FLAGS.has(before);
  });
}
// Modes that list, show, export or set up instead of running the scheme action: a `test` beside them
// selects what to show (xcodebuild -showBuildSettings test) and runs nothing.
const XCODE_NON_RUNNING = new Set(['-usage', '-help', '-license', '-checkFirstLaunchStatus', '-runFirstLaunch', '-downloadAllPlatforms',
  '-prepareDeviceSupport', '-downloadPlatform', '-importPlatform', '-downloadComponent', '-importComponent', '-deleteComponent',
  '-showComponent', '-showsdks', '-showdestinations', '-showTestPlans', '-showBuildSettings', '-showBuildSettingsForIndex', '-list',
  '-find-executable', '-find-library', '-version', '-exportArchive', '-exportNotarizedApp', '-exportLocalizations', '-importLocalizations',
  '-enumerate-tests', '-resolvePackageDependencies', '-create-xcframework']);
// Whether a direct xcodebuild actually runs tests; shared by the overlap and the coverage checks.
export const isTestAction = tokens => !tokens.some(token => XCODE_NON_RUNNING.has(token))
  && xcodeActions(tokens).some(action => action === 'test' || action === 'test-without-building');

const ONLY = '-only-testing:', SKIP = '-skip-testing:';
const within = (id, target) => id === target || id.startsWith(`${target}/`);
// Whether one check command runs all of test `id`. A direct xcodebuild counts only with a test
// action and only through its selection: unnarrowed, or an -only-testing naming `id` or an
// ancestor. Any other command (wrapper script, other runner) counts when an argument contains
// `id`; the start check cannot see inside it. An -skip-testing on `id`, an ancestor or a part
// of it (one method of the class) means it does not run all of it.
export function advisoryRunsTest(tokens, id) {
  if (tokens.some(token => token.startsWith(SKIP)
    && (within(id, token.slice(SKIP.length)) || within(token.slice(SKIP.length), id)))) return false;
  if (isXcodebuild(tokens)) {
    if (!isTestAction(tokens)) return false;
    const only = tokens.filter(token => token.startsWith(ONLY)).map(token => token.slice(ONLY.length));
    return !tokens.some(token => token.startsWith('-only-testing')) || only.some(target => within(id, target));
  }
  return tokens.some(token => !token.startsWith('-skip-testing') && token.includes(id));
}

const directXcode = tokens => tokens[0] === '/usr/bin/xcodebuild'
  || tokens[0] === '/usr/bin/xcrun' && tokens[1] === 'xcodebuild';
const cleanRelative = value => typeof value === 'string' && value.length > 0
  && !value.startsWith('/') && !/[\\\x00-\x1f]/.test(value)
  && value.replace(/^\.\//, '').split('/').every(part => part && part !== '..' && part !== '.');
const normalizeFile = value => value.replace(/^\.\//, '');
const XCODE_SELECTION_VALUES=new Set(['-scheme','-project','-workspace','-destination','-destination-timeout',
  '-configuration','-sdk','-arch','-derivedDataPath','-resultBundlePath','-resultBundleVersion',
  '-enableCodeCoverage','-parallel-testing-enabled','-maximum-concurrent-test-simulator-destinations',
  '-maximum-concurrent-test-device-destinations']);
function modeledXcodeArguments(tokens){
  for(let index=tokens[0]==='/usr/bin/xcrun'?2:1;index<tokens.length;index++){
    const token=tokens[index];
    if(token.startsWith(ONLY)||token.startsWith(SKIP))continue;
    if(XCODE_SELECTION_VALUES.has(token)){
      if(typeof tokens[index+1]!=='string'||tokens[index+1].startsWith('-'))return false;
      index++;continue;
    }
    if(token.startsWith('-')&&!XCODE_FLAGS.has(token)&&!XCODE_NON_RUNNING.has(token))return false;
    // Unknown build-setting overrides could change which tests are compiled.
    if(!token.startsWith('-')&&token.includes('=')&&token!=='COMPILER_INDEX_STORE_ENABLE=NO')return false;
  }
  return true;
}

// Return true/false only for the command forms whose test selection is modeled.
// A wrapper mentioning a test is unknown, not proof that it runs that test.
function mandatorySelection(tokens, id) {
  if (!Array.isArray(tokens) || tokens.length === 0 || !tokens.every(token => typeof token === 'string' && token.length > 0))
    return null;
  if (directXcode(tokens)) {
    // A source-file path is not an XCTest target/class/method identifier.
    // Source-to-test mappings must be explicit in the approved contract.
    if (!/^[A-Za-z_][A-Za-z0-9_-]*(?:\/[A-Za-z_][A-Za-z0-9_]*(?:\(\))?){0,2}$/.test(id)) return null;
    // These option forms do not match Xcode's documented colon selection syntax.
    if (tokens.some(token => /^-(?:only|skip)-testing(?:$|=)/.test(token))) return null;
    if (!modeledXcodeArguments(tokens)) return null;
    // Scheme defaults/test plans can omit targets or skip methods even with an
    // explicit selector. Argv can prove exclusion, never the resolved inventory.
    return advisoryRunsTest(tokens, id) ? null : false;
  }
  // Bare PATH lookups and project binaries named "node" do not establish the
  // actual interpreter. The caller can use its already running Node executable.
  if (tokens[0] !== process.execPath) return null;
  if (!/\.(?:cjs|mjs|js)$/.test(id)) return null;
  const args = tokens.slice(1);
  // An explicit script invocation runs that file; it does not prove that an
  // unrelated test name supplied as an argument is run by that script.
  if (args.length === 1 && !args[0].startsWith('-') && cleanRelative(args[0])) return normalizeFile(args[0]) === normalizeFile(id);
  // Modeled native runner options are shared by planning and collected checks.
  // This does not rewrite argv or execute a different command.
  const files = selectedNodeTestFiles(tokens);
  if(files===null)return null;
  return files.some(file => normalizeFile(file) === normalizeFile(id));
}

// Caller binds requiredTests to the approved specification and commands to the
// checks actually run. This function is read-only and never treats an empty
// warning list, a developer claim, or a wrapper argument as execution evidence.
export function mandatoryCheckCoverage({requiredTests, commands}) {
  if (!Array.isArray(requiredTests) || !requiredTests.every(cleanRelative)
    || new Set(requiredTests).size !== requiredTests.length || !Array.isArray(commands))
    throw Object.assign(new Error('mandatory_check_contract_invalid'), {code: 'mandatory_check_contract_invalid'});
  const missing = [], unverifiable = [];
  for (const id of requiredTests) {
    const selections = commands.map(tokens => mandatorySelection(tokens, id));
    if (selections.includes(true)) continue;
    missing.push(id);
    if (selections.includes(null)) unverifiable.push(id);
  }
  return {satisfied: missing.length === 0, missing, unverifiable};
}

