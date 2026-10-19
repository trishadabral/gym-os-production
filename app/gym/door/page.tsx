'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { QrCode, RefreshCw, WifiOff } from 'lucide-react';

const REFRESH_MS = 25_000; // faster than the 30s rotation window

interface DoorCode {
  qr: string;
  branch_id: string;
  branch_name: string;
  expires_at: number;
  server_time: number;
}

export default function DoorModePage() {
  const [code, setCode] = useState<DoorCode | null>(null);
  const [qrUrl, setQrUrl] = useState('');
  const [offline, setOffline] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const timerRef = useRef<number | null>(null);

  const fetchCode = useCallback(async () => {
    try {
      const res = await fetch('/api/door-code', { cache: 'no-store' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.data?.qr) throw new Error(json.error || 'Failed to load door code');
      const data = json.data as DoorCode;
      const url = await QRCode.toDataURL(data.qr, { width: 480, margin: 2 });
      setCode(data);
      setQrUrl(url);
      setOffline(false);
    } catch {
      // Never show a stale QR: on failure the screen goes to the offline state.
      setOffline(true);
      setCode(null);
      setQrUrl('');
    }
  }, []);

  useEffect(() => {
    fetchCode();
    timerRef.current = window.setInterval(fetchCode, REFRESH_MS);
    const tick = window.setInterval(() => {
      setSecondsLeft((prev) => {
        if (!code) return 0;
        return Math.max(0, Math.ceil((code.expires_at - Date.now()) / 1000));
      });
    }, 500);
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      window.clearInterval(tick);
    };
  }, [fetchCode, code?.expires_at]);

  return (
    <div className="flex min-h-[80vh] flex-col items-center justify-center gap-6 p-6 text-center">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Door check-in</h1>
        <p className="mt-1 text-sm text-slate-500">
          {code ? code.branch_name : 'Members scan this code with their phone to check in'}
        </p>
      </div>

      {offline || !qrUrl ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-10">
          <WifiOff className="h-10 w-10 text-amber-500" />
          <p className="text-lg font-semibold text-amber-800">OFFLINE</p>
          <p className="max-w-xs text-sm text-amber-700">
            Could not load a fresh door code. Use the attendance scanner until this screen
            shows a code again — never photograph or reuse an old one.
          </p>
          <button
            onClick={fetchCode}
            className="mt-2 inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700"
          >
            <RefreshCw className="h-4 w-4" /> Retry
          </button>
        </div>
      ) : (
        <>
          <div className="rounded-3xl bg-white p-6 shadow-xl ring-1 ring-slate-200">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrUrl} alt="Rotating door check-in code" className="h-72 w-72" />
          </div>
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <QrCode className="h-4 w-4" />
            <span>
              New code in <span className="font-semibold text-slate-700">{secondsLeft}s</span>
              <span className="mx-2 text-slate-300">•</span>
              codes expire automatically
            </span>
          </div>
        </>
      )}
    </div>
  );
}
