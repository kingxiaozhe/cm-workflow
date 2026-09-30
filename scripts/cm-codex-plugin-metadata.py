#!/usr/bin/env python3
"""Small metadata fallback for Codex versions without the old optional helpers.

Official plugin-creator still owns marketplace registration; Codex CLI validates
and installs the plugin. This script only reads a marketplace name or updates a
staged plugin's cache version. It never installs or edits user configuration.
"""
import datetime
import hashlib
import json
from pathlib import Path
import re
import sys


def object_pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('duplicate JSON key: ' + key)
        value[key] = item
    return value


def read_object(file):
    if file.is_symlink() or not file.is_file():
        raise ValueError('metadata must be a regular non-symlink file')
    value = json.loads(file.read_text(encoding='utf-8'), object_pairs_hook=object_pairs)
    if not isinstance(value, dict):
        raise ValueError('metadata must be a JSON object')
    return value


def main(args):
    if len(args) != 2 or args[0] not in ('marketplace-name', 'initialize-marketplace', 'cache-version'):
        raise ValueError('usage: cm-codex-plugin-metadata.py {marketplace-name|initialize-marketplace|cache-version} PATH')
    operation, raw = args
    if operation == 'initialize-marketplace':
        file = Path(raw)
        marketplace = read_object(file)
        if marketplace.get('name') == '[TODO: marketplace-name]':
            plugins = marketplace.get('plugins')
            if not isinstance(plugins, list) or len(plugins) != 1 or not isinstance(plugins[0], dict) or plugins[0].get('name') != 'cm-workflow':
                raise ValueError('initial marketplace must be the official fresh CM scaffold')
            marketplace['name'] = 'personal'
            interface = marketplace.get('interface')
            if isinstance(interface, dict) and interface.get('displayName') == '[TODO: display-name]':
                interface['displayName'] = 'Personal plugins'
            file.write_text(json.dumps(marketplace, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        elif not isinstance(marketplace.get('name'), str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', marketplace['name']):
            raise ValueError('initial marketplace requires a valid name or official placeholder')
        return
    if operation == 'marketplace-name':
        name = read_object(Path(raw)).get('name')
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', name):
            raise ValueError('marketplace requires a valid name')
        print(name)
        return
    root = Path(raw)
    if root.is_symlink() or not root.is_dir():
        raise ValueError('stage must be a real directory')
    file = root / '.codex-plugin' / 'plugin.json'
    if file.parent.is_symlink():
        raise ValueError('manifest parent must be a real directory')
    plugin = read_object(file)
    version = (root / 'VERSION').read_text(encoding='utf-8').strip()
    if plugin.get('name') != 'cm-workflow' or not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('cache version requires a CM plugin and base VERSION')
    if plugin.get('version', '').split('+', 1)[0] != version:
        raise ValueError('manifest base version must match VERSION')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S%f')
    fingerprint = hashlib.sha256(file.read_bytes()).hexdigest()[:12]
    plugin['version'] = version + '+codex.' + stamp + '.' + fingerprint
    file.write_text(json.dumps(plugin, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(plugin['version'])


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (ValueError, OSError) as error:
        print('ERROR: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
