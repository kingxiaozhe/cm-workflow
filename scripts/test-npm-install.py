#!/usr/bin/env python3
"""Isolated package/installer fixture; final Codex registration is simulated.

Never changes HOME/CODEX_HOME or the live installation. Only the three installer
path assignments are relocated in a fixture copy; transaction code is unchanged.
Requires macOS, Node 24.14+, npm, Git, Python and local Codex plugin helpers.
"""
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def run(args, *, cwd=ROOT, env=None, expected=0, input=None):
    result = subprocess.run(args, cwd=cwd, env=env, input=input, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if result.returncode != expected:
        raise AssertionError(f"{args[0]} exited {result.returncode}, expected {expected}\n{result.stdout}")
    return result.stdout


def tree(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob('*') if p.is_file()}


def relocated(source, home, helpers):
    text = (source / 'install-codex.sh').read_text()
    replacements = {
        'MARKETPLACE_ROOT="$HOME/.agents/plugins"':
            'MARKETPLACE_ROOT=' + shlex.quote(str(home / '.agents/plugins')),
        'PLUGIN_PARENT="$HOME/plugins"':
            'PLUGIN_PARENT=' + shlex.quote(str(home / 'plugins')),
        'CREATOR_ROOT="$CODEX_HOME/skills/.system/plugin-creator"':
            'CREATOR_ROOT=' + shlex.quote(str(helpers)),
    }
    for old, new in replacements.items():
        assert text.count(old) == 1, f'Installer preamble changed: {old}'
        text = text.replace(old, new, 1)
    target = source / '.npm-installer-fixture.sh'
    target.write_text(text)
    return target


def main():
    assert sys.platform == 'darwin', 'This integration fixture requires macOS'
    helpers = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'skills/.system/plugin-creator'
    assert (helpers / 'scripts/create_basic_plugin.py').is_file(), 'Codex bundled helpers required'
    with tempfile.TemporaryDirectory(prefix='cm-npm-fixture-') as folder:
        temp = Path(folder).resolve()
        # Include spaces to catch unsafe shell/path forwarding.
        unpack = temp / 'npm package'
        unpack.mkdir()
        info = json.loads(run(['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', str(temp)]))[0]
        archive = temp / info['filename']
        packed_paths = {f['path'] for f in info['files']}
        assert {'.codex-plugin/plugin.json', 'install-codex.sh', 'install.sh', 'install.ps1',
                'scripts/cm-workflow.mjs', 'AGENTS.md', 'SECURITY.md', 'CONTRIBUTING.md'} <= packed_paths
        assert not any(p.startswith(('.omx/', '.git/', '.env')) for p in packed_paths)
        run(['tar', '-xzf', str(archive), '-C', str(unpack)])
        package = unpack / 'package'
        metadata = json.loads((package / 'package.json').read_text())
        assert not metadata.get('scripts') and not metadata.get('dependencies')
        assert metadata['version'] == (package / 'VERSION').read_text().strip()
        assert metadata['version'] == json.loads((package / '.codex-plugin/plugin.json').read_text())['version']
        outside = temp / 'unrelated project'
        outside.mkdir()
        help_text = run(['npm', 'exec', '--offline', '--yes', '--cache', str(temp / 'npm-cache'),
                         '--package', str(archive), '--', 'cm-workflow', '--help'], cwd=outside)
        assert 'Usage: cm-workflow install' in help_text, help_text
        (outside / 'tasks.md').write_text('T-001 remains pending\n')
        project_before = tree(outside)
        source = temp / 'old source checkout'
        source.mkdir()
        old_archive = temp / 'source.tar'
        run(['git', 'archive', '--format=tar', '-o', str(old_archive), 'HEAD'])
        run(['tar', '-xf', str(old_archive), '-C', str(source)])
        source_before = tree(source)
        bin_dir = temp / 'bin'
        bin_dir.mkdir()
        fake = bin_dir / 'codex'
        fake.write_text('#!' + sys.executable + '\n' + '''import json, os, pathlib, sys
args = sys.argv[1:]
assert len(args) == 3 and args[:2] == ['plugin', 'add'], args
assert args[2].startswith('cm-workflow@'), args
with pathlib.Path(os.environ['CM_NPM_FIXTURE_CALLS']).open('a') as out:
    out.write(json.dumps(args) + '\\n')
sys.exit(17 if os.environ.get('CM_NPM_FIXTURE_FAIL') == '1' else 0)
''')
        fake.chmod(0o755)
        env = {**os.environ, 'PATH': str(bin_dir) + os.pathsep + os.environ['PATH'],
               'CM_NPM_FIXTURE_CALLS': str(temp / 'calls.jsonl')}
        # The shipped Node entry still chooses the original script and arguments.
        # Its injected subprocess executes only our relocated fixture copy.
        bridge = temp / 'entry-fixture.mjs'
        bridge.write_text('''import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const [pkg,fixture,...args]=process.argv.slice(2);
const {main}=await import(pathToFileURL(pkg+'/scripts/cm-workflow.mjs'));
process.exitCode=main(args,{run:(command,argv,options)=>{
  assert.equal(command,'/bin/bash');
  assert.equal(argv[0],pkg+'/install-codex.sh');
  return spawnSync(command,[fixture,...argv.slice(1)],options);
}});
''')

        def install(pkg, home, *, npm=True, yes=True, fail=False, input=None):
            fixture = relocated(pkg, home, helpers)
            args = ['install'] + (['--yes'] if yes else [])
            command = (['node', str(bridge), str(pkg), str(fixture), *args] if npm else
                       ['/bin/bash', str(fixture), *args[1:]])
            try:
                return run(command, cwd=outside, env={**env, 'CM_NPM_FIXTURE_FAIL': '1' if fail else '0'},
                           expected=17 if fail else 0, input=input)
            finally:
                fixture.unlink()

        fresh = temp / 'fresh user'
        install(package, fresh)
        assert (fresh / 'plugins/cm-workflow/skills/cm-ai/SKILL.md').is_file()
        print('PASS: tarball contents, offline npm CLI and fresh file installation', flush=True)

        upgrade = temp / 'existing user'
        install(source, upgrade, npm=False)
        dest = upgrade / 'plugins/cm-workflow'
        marketplace = upgrade / '.agents/plugins/marketplace.json'
        payload = json.loads(marketplace.read_text())
        sibling = {**payload['plugins'][0], 'name': 'unrelated-plugin'}
        payload['plugins'].append(sibling)
        marketplace.write_text(json.dumps(payload))
        (dest / 'old-local-edit.txt').write_text('fixture old plugin marker\n')
        before = tree(upgrade)
        calls = (temp / 'calls.jsonl').read_bytes()
        assert 'cancelled' in install(package, upgrade, yes=False, input='n\n').lower()
        assert tree(upgrade) == before
        assert (temp / 'calls.jsonl').read_bytes() == calls
        print('PASS: declined upgrade preserves plugin and marketplace', flush=True)

        install(package, upgrade, fail=True)
        assert tree(upgrade) == before
        print('PASS: failed source-to-npm upgrade restores exact previous files', flush=True)

        install(package, upgrade)
        assert not (dest / 'old-local-edit.txt').exists()
        installed_entries = json.loads(marketplace.read_text())['plugins']
        assert sum(p['name'] == 'cm-workflow' for p in installed_entries) == 1
        assert sibling in installed_entries
        for folder in ['skills', 'runtime', 'templates', 'scripts', 'agents', 'compat', 'docs', 'assets']:
            assert tree(package / folder) == tree(dest / folder), folder
        assert tree(source) == source_before
        assert tree(outside) == project_before
        print('PASS: source-to-npm upgrade replaces same plugin; project/source and other entry preserved', flush=True)

        failed_fresh = temp / 'failed fresh user'
        install(package, failed_fresh, fail=True)
        assert not (failed_fresh / 'plugins/cm-workflow').exists()
        assert not (failed_fresh / '.agents/plugins/marketplace.json').exists()
        print('PASS: failed fresh registration leaves no plugin or marketplace file', flush=True)
        print('LIMIT: Codex registration simulated; registry publication and live cache ingestion not tested.')


if __name__ == '__main__':
    main()
