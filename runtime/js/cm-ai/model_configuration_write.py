#!/usr/bin/env python3
"""POSIX publication only: pinned directories, cooperative lock, byte CAS.

The containing directory must be owned by the caller and not group/world writable.
This does not sandbox a same-UID actor that can move that directory or ignore locks.
"""
import base64
import errno
import hashlib
import json
import os
import stat
import sys
import uuid

LIMIT = 64 * 1024
RUN_DIRECTORIES = {'.cm-external-models-v1', '.reviews', '.cm-model-runtime-v1', '.cm-model-reviews-v1',
                   '.cm-model-runtime-v2', '.cm-model-reviews-v2', '.cm-model-fix-runtime-v1'}
RUN_FILES = {'.cm-task-owner.json', '.cm-model-code-owner-v1.json',
             '.cm-model-project-owner-v2.json', '.cm-model-snapshot-v1.json',
             '.cm-model-fix-owner-v1.json'}
LOCK = '.cm-model-config.lock'
SECURE_PLATFORM = (os.name == 'posix' and hasattr(os, 'O_NOFOLLOW') and hasattr(os, 'O_DIRECTORY')
                   and all(function in os.supports_dir_fd for function in
                           (os.open, os.mkdir, os.stat, os.link, os.unlink, os.rename)))


class Refusal(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Refusal(code)


def validate_target(target):
    require(isinstance(target, str) and os.path.isabs(target)
            and os.path.normpath(target) == target, 'unsupported_model_path')
    require(not any(part.lower() in RUN_DIRECTORIES for part in target.split(os.sep))
            and os.path.basename(target).lower() not in RUN_FILES | {LOCK},
            'model_output_run_path_forbidden')


def open_parent(target, create):
    """Never resolve an ancestor through a symlink, including during mkdir."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    current = os.open(os.sep, flags)
    try:
        for part in os.path.dirname(target).split(os.sep)[1:]:
            try:
                child = os.open(part, flags, dir_fd=current)
            except FileNotFoundError:
                require(create, 'unsupported_model_path')
                try:
                    os.mkdir(part, 0o700, dir_fd=current)
                    os.fsync(current)
                except FileExistsError:
                    pass
                child = os.open(part, flags, dir_fd=current)
            os.close(current)
            current = child
        info = os.fstat(current)
        require(info.st_uid == os.geteuid() and not info.st_mode & 0o022,
                'model_configuration_untrusted_directory')
        return current
    except BaseException:
        os.close(current)
        raise


def file_hash(parent, name):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    except FileNotFoundError:
        return None
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                and before.st_size <= LIMIT, 'invalid_model_configuration_file')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            content = stream.read(LIMIT + 1)
        after = os.stat(name, dir_fd=parent, follow_symlinks=False)
        identity = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
                                 info.st_ctime_ns, info.st_nlink)
        require(len(content) <= LIMIT and identity(before) == identity(os.fstat(fd)) and identity(before) == identity(after),
                'model_configuration_changed')
        return hashlib.sha256(content).hexdigest()
    finally:
        os.close(fd)


def publish(request):
    require(SECURE_PLATFORM, 'model_secure_write_unavailable')
    import fcntl
    require(set(request) == {'target', 'bytes', 'expectedSha256', 'replace', 'createParents', 'sourceGuard'},
            'invalid_model_write_request')
    target = request['target']
    validate_target(target)
    require(type(request['replace']) is bool and type(request['createParents']) is bool,
            'invalid_model_write_request')
    content = base64.b64decode(request['bytes'], validate=True)
    require(len(content) <= LIMIT, 'model_configuration_too_large')
    expected = request['expectedSha256']
    require(expected is None or isinstance(expected, str) and len(expected) == 64
            and all(c in '0123456789abcdef' for c in expected), 'invalid_model_write_request')
    guard = request['sourceGuard']
    if guard is not None:
        require(isinstance(guard, dict) and set(guard) == {'file', 'sha256'}
                and isinstance(guard['file'], str)
                and isinstance(guard['sha256'], str) and len(guard['sha256']) == 64
                and all(c in '0123456789abcdef' for c in guard['sha256'])
                and os.path.dirname(guard['file']) == os.path.dirname(target),
                'invalid_model_write_request')
        validate_target(guard['file'])
    parent = open_parent(target, request['createParents'])
    lock = None
    temporary = None
    published = False
    try:
        try:
            lock = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        except FileExistsError:
            try:
                lock = os.open(LOCK, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            except FileNotFoundError:
                raise Refusal('model_configuration_busy')
        info = os.fstat(lock)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.geteuid()
                and not info.st_mode & 0o077, 'invalid_model_configuration_lock')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refusal('model_configuration_busy')
        # Persistent lock inode: never unlink it, including after crash or success.
        require(os.stat(LOCK, dir_fd=parent, follow_symlinks=False).st_ino == info.st_ino,
                'invalid_model_configuration_lock')
        name = os.path.basename(target)
        actual = file_hash(parent, name)
        require(request['replace'] or actual is None, 'model_configuration_exists')
        require(actual == expected, 'model_configuration_changed')
        if guard is not None:
            require(file_hash(parent, os.path.basename(guard['file'])) == guard['sha256'],
                    'model_configuration_changed')
        temporary = '.cm-model-' + uuid.uuid4().hex + '.tmp'
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        require(file_hash(parent, name) == expected, 'model_configuration_changed')
        if actual is None:
            try:
                os.link(temporary, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            except FileExistsError:
                raise Refusal('model_configuration_changed')
            published = True
            os.unlink(temporary, dir_fd=parent)
        else:
            os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
            published = True
        temporary = None
        os.fsync(parent)
        # A renamed pinned directory cannot redirect the write, but the named
        # configuration may no longer refer to it. Do not report success then.
        named_parent = open_parent(target, False)
        try:
            pinned, named = os.fstat(parent), os.fstat(named_parent)
            require((pinned.st_dev, pinned.st_ino) == (named.st_dev, named.st_ino),
                    'model_configuration_write_unknown')
        finally:
            os.close(named_parent)
    except BaseException:
        if published:
            raise Refusal('model_configuration_write_unknown')
        raise
    finally:
        cleanup_error = None
        if temporary is not None:
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass
            except OSError as error:
                cleanup_error = error
        for descriptor in (lock, parent):
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError as error:
                    cleanup_error = error
        if cleanup_error is not None:
            if published:
                raise Refusal('model_configuration_write_unknown')
            raise cleanup_error


def main():
    try:
        data = sys.stdin.buffer.read(192 * 1024 + 1)
        require(len(data) <= 192 * 1024, 'model_configuration_too_large')
        publish(json.loads(data))
        print(json.dumps({'ok': True}))
    except Exception as error:
        code = str(error) if isinstance(error, Refusal) else (
            'unsupported_model_path' if isinstance(error, OSError) and error.errno in (errno.ELOOP, errno.ENOTDIR)
            else 'model_configuration_write_failed')
        print(json.dumps({'ok': False, 'code': code}))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
