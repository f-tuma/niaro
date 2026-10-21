#!/usr/bin/env python3
"""Measure the installed, isolated release APK on an emulator; no host microphone.

Private file extraction is a separate post-run step because release run-as is disabled.
The runner stops capture before returning, including on an ordinary signal/failure.
"""
import argparse
import json
import re
import signal
import time
from pathlib import Path
import soak

PACKAGE = 'dev.agentclient.demo.audio.profile'


def release_flags(raw):
    flags = re.search(r'^\s*flags=\[([^\]]+)\]', raw, re.M)
    if not flags or 'DEBUGGABLE' in flags[1].split():
        raise RuntimeError('A verified non-debuggable release package is required')
    return flags[1].strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--adb', default='adb')
    parser.add_argument('--serial', default='emulator-5554')
    parser.add_argument('--duration', type=int, default=1800)
    parser.add_argument('--warmup', type=int, default=120)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'emulator-\d+', args.serial) or not 60 <= args.duration <= 3600 or not 0 <= args.warmup <= 600:
        parser.error('Use a named emulator, duration 60–3600 and warm-up 0–600 seconds')
    soak.PACKAGE = PACKAGE
    device = soak.Device(args.adb, args.serial)
    args.output.mkdir(parents=True, exist_ok=False)
    report = {'package': PACKAGE, 'started_utc': soak.utc(), 'duration_s': args.duration,
              'warmup_s': args.warmup, 'samples': [], 'warmup_samples': [], 'status': 'preflight'}
    owned = False
    old_timeout = None
    def save():
        (args.output/'report.tmp').write_text(json.dumps(report, indent=2)+'\n')
        (args.output/'report.tmp').replace(args.output/'report.json')
    def interrupted(*_):
        raise InterruptedError('Measurement interrupted')
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    def sample(elapsed, prefix):
        raw = device.shell('dumpsys', 'meminfo', PACKAGE)
        (args.output/f'{prefix}-{round(elapsed)}.txt').write_text(raw)
        native = re.search(r'Native Heap:\s*(\d+)', raw)
        if not native:
            raise RuntimeError('Missing Native Heap summary')
        return {'elapsed_s': round(elapsed, 3), 'utc': soak.utc(), 'pid': device.shell('pidof', PACKAGE),
                'foreground': device.foreground(), 'microphone_active': device.microphone_active(),
                'native_kib': int(native[1]), **soak.memory_summary(raw)}
    try:
        if device.shell('getprop', 'ro.kernel.qemu') != '1':
            raise RuntimeError('Only an emulator is supported')
        report['host_microphone'] = device.run('emu', 'avd', 'hostmicoff')
        if report['host_microphone'] != 'OK':
            raise RuntimeError('Host microphone forwarding could not be disabled')
        report['flags'] = release_flags(device.shell('dumpsys', 'package', PACKAGE))
        if not device.foreground() or device.microphone_active():
            raise RuntimeError('Open the idle release audio screen at the top')
        report['environment'] = {k: device.shell('getprop', k) for k in ['ro.build.version.sdk','ro.build.fingerprint','ro.product.cpu.abi']}
        old_timeout = device.shell('settings','get','system','screen_off_timeout')
        device.shell('settings','put','system','screen_off_timeout','2147483647')
        report['status'] = 'warming_up'
        start = time.monotonic()
        while True:
            row = sample(time.monotonic()-start, 'warmup')
            if row['microphone_active'] or not row['foreground']:
                raise RuntimeError('Idle warm-up interrupted')
            report['warmup_samples'].append(row); save()
            if row['elapsed_s'] >= args.warmup: break
            time.sleep(min(30, max(0, args.warmup-(time.monotonic()-start))))
        dump = device.shell('uiautomator','dump','/sdcard/release-audio.xml')
        if 'UI hierchary dumped to' not in dump:
            raise RuntimeError('Fresh Start control unavailable')
        xml = device.run('exec-out','cat','/sdcard/release-audio.xml')
        (args.output/'before.xml').write_text(xml)
        point = soak.button_center(xml)
        device.screenshot(args.output/'before.png')
        owned = True
        report['capture_requested_utc'] = soak.utc()
        start = time.monotonic()
        device.shell('input','tap',*map(str,point))
        time.sleep(1)
        report['status'] = 'recording'
        while True:
            elapsed = time.monotonic()-start
            row = sample(elapsed, 'recording')
            report['samples'].append(row); save(); print(json.dumps(row), flush=True)
            if not row['microphone_active'] or not row['foreground'] or (len(report['samples'])>1 and row['pid'] != report['samples'][0]['pid']):
                raise RuntimeError('Recording/process continuity was lost')
            if elapsed >= args.duration: break
            time.sleep(max(0, min(start+args.duration, start+60*len(report['samples']))-time.monotonic()))
        device.screenshot(args.output/'before-stop.png')
        report['stop_elapsed_s'] = time.monotonic()-start
        device.shell('input','keyevent','3'); time.sleep(2)
        if device.microphone_active(): raise RuntimeError('Microphone still active after Home')
        owned = False
        report['status'] = 'capture_complete_pending_file_validation'
        report['after_stop'] = sample(time.monotonic()-start, 'after-stop')
        (args.output/'native.log').write_text(device.run('logcat','-d','--pid='+row['pid'],'ReactNativeJS:V','AndroidRuntime:E','*:S'))
    except Exception as error:
        report['status'] = 'failed'; report['error'] = str(error)
        raise
    finally:
        if owned:
            try:
                if device.foreground(): device.shell('input','keyevent','3'); time.sleep(1)
                if device.microphone_active(): device.shell('am','force-stop',PACKAGE)
            except Exception as error: report['cleanup_error'] = str(error)
        if old_timeout is not None:
            try:
                if old_timeout == 'null': device.shell('settings','delete','system','screen_off_timeout')
                else: device.shell('settings','put','system','screen_off_timeout',old_timeout)
            except Exception as error:
                report['settings_restore_error'] = str(error)
                report['status'] = 'failed'
        report['finished_utc'] = soak.utc(); save()

if __name__ == '__main__':
    main()
