'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Html5Qrcode } from 'html5-qrcode';
import { CheckCircle2, Loader2, MapPin, QrCode, RotateCcw, XCircle } from 'lucide-react';

type Phase = 'idle' | 'scanning' | 'locating' | 'submitting' | 'done';

const FRIENDLY_ERRORS: Record<string, string> = {
  code_expired: 'That code just expired — tap scan again and use the fresh one.',
  code_reused: 'That code was already used — scan the fresh code on the door screen.',
  code_invalid: "That doesn't look like a door code — scan the code on the door screen.",
  outside_gym: "We can't confirm you're at the gym. Turn on location services and try again.",
  membership_expired: 'Your membership has expired — please renew at the desk.',
  member_invalid: 'This check-in link is not valid — ask the gym desk for a new one.',
  at_capacity: 'The gym is at capacity right now — please wait a few minutes.',
};

function getPosition(): Promise<{ lat: number; lng: number; accuracy: number | null }> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('location_unavailable'));
      return;
    }
    // One fresh fix; up to 10s to get an indoor lock before failing.
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? null,
        }),
      () => reject(new Error('location_unavailable')),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }
    );
  });
}

function CheckinFlow() {
  const searchParams = useSearchParams();
  const memberToken = (searchParams.get('m') || '').trim();

  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const [ok, setOk] = useState(false);
  const [detail, setDetail] = useState('');
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const busyRef = useRef(false);
  const elementId = 'door-qr-reader';

  const stopScanner = useCallback(async () => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop();
        await scannerRef.current.clear();
      } catch {
        // ignore
      }
      scannerRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    stopScanner();
  }, [stopScanner]);

  const submit = useCallback(
    async (doorQr: string) => {
      setPhase('locating');
      setMessage('');
      let coords: { lat: number; lng: number; accuracy: number | null };
      try {
        coords = await getPosition();
      } catch {
        setPhase('done');
        setOk(false);
        setMessage('Location is required to check in. Allow location access and try again.');
        return;
      }

      setPhase('submitting');
      try {
        const res = await fetch('/api/checkin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            door_qr: doorQr,
            member_token: memberToken,
            lat: coords.lat,
            lng: coords.lng,
            accuracy: coords.accuracy,
          }),
        });
        const json = await res.json().catch(() => ({}));
        setPhase('done');
        if (res.ok) {
          setOk(true);
          setMessage(json.message || 'Checked in — enjoy your workout!');
          setDetail(json.data?.visit?.check_in_at ? `at ${new Date(json.data.visit.check_in_at).toLocaleTimeString()}` : '');
        } else if (res.status === 409 && json.code === 'already_checked_in') {
          setOk(true);
          setMessage(json.message || 'You are already checked in.');
          setDetail('');
        } else {
          setOk(false);
          setMessage(
            (json.code && FRIENDLY_ERRORS[json.code]) || json.error || 'Check-in failed, please try again.'
          );
          setDetail('');
        }
      } catch {
        setPhase('done');
        setOk(false);
        setMessage('Network error — check your connection and try again.');
        setDetail('');
      }
    },
    [memberToken]
  );

  const startScan = useCallback(async () => {
    if (busyRef.current || scannerRef.current) return;
    busyRef.current = true;
    setMessage('');
    setDetail('');
    setOk(false);
    setPhase('scanning');
    // Wait for the reader element to render.
    await new Promise((r) => setTimeout(r, 50));
    try {
      const scanner = new Html5Qrcode(elementId);
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        (decodedText) => {
          const text = decodedText.trim();
          if (!text) return;
          stopScanner().finally(() => {
            busyRef.current = false;
            submit(text);
          });
        },
        () => {
          // per-frame decode miss — ignore
        }
      );
    } catch (err) {
      busyRef.current = false;
      scannerRef.current = null;
      setPhase('done');
      setOk(false);
      const msg = err instanceof Error ? err.message : String(err);
      setMessage(
        msg.includes('NotAllowedError') || msg.toLowerCase().includes('secure context')
          ? 'Camera access was blocked. Allow camera permission (and use HTTPS) then try again.'
          : `Could not start the camera: ${msg}`
      );
    }
  }, [stopScanner, submit]);

  const reset = useCallback(() => {
    busyRef.current = false;
    setPhase('idle');
    setMessage('');
    setDetail('');
    setOk(false);
  }, []);

  if (!memberToken) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
        <QrCode className="h-10 w-10 text-slate-400" />
        <h1 className="text-xl font-bold text-slate-900">Gym check-in</h1>
        <p className="text-sm text-slate-500">
          This page needs your personal check-in link. Ask the gym desk to send it to you
          (it&apos;s the link from your welcome message), then open it to check in.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center gap-5 p-6">
      <div className="pt-8 text-center">
        <h1 className="text-2xl font-bold text-slate-900">Gym check-in</h1>
        <p className="mt-1 text-sm text-slate-500">Scan the code on the door screen</p>
      </div>

      {(phase === 'idle' || phase === 'done') && (
        <div id={elementId} className={phase === 'done' ? 'hidden' : 'w-full overflow-hidden rounded-2xl'} />
      )}
      {phase === 'scanning' && (
        <div id={elementId} className="w-full overflow-hidden rounded-2xl" />
      )}

      {phase === 'idle' && (
        <button
          onClick={startScan}
          className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-900 px-6 py-4 text-lg font-semibold text-white active:scale-[0.98]"
        >
          <QrCode className="h-6 w-6" /> Scan door code
        </button>
      )}

      {phase === 'scanning' && (
        <button
          onClick={() => {
            stopScanner().finally(reset);
          }}
          className="rounded-xl border border-slate-300 px-5 py-2.5 text-sm font-medium text-slate-700"
        >
          Cancel
        </button>
      )}

      {(phase === 'locating' || phase === 'submitting') && (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <Loader2 className="h-10 w-10 animate-spin text-slate-500" />
          <p className="text-sm text-slate-600">
            {phase === 'locating' ? (
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="h-4 w-4" /> Getting your location…
              </span>
            ) : (
              'Confirming your check-in…'
            )}
          </p>
        </div>
      )}

      {phase === 'done' && (
        <div
          className={`flex w-full flex-col items-center gap-2 rounded-2xl border p-6 text-center ${
            ok ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'
          }`}
        >
          {ok ? (
            <CheckCircle2 className="h-10 w-10 text-green-600" />
          ) : (
            <XCircle className="h-10 w-10 text-red-500" />
          )}
          <p className={`font-semibold ${ok ? 'text-green-800' : 'text-red-800'}`}>{message}</p>
          {detail && <p className="text-sm text-green-700">{detail}</p>}
          <button
            onClick={reset}
            className="mt-2 inline-flex items-center gap-2 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white"
          >
            <RotateCcw className="h-4 w-4" /> {ok ? 'Done' : 'Try again'}
          </button>
        </div>
      )}

      <p className="mt-auto pb-4 text-center text-xs text-slate-400">
        Your location is used only to confirm you&apos;re at the gym for this check-in.
      </p>
    </div>
  );
}

export default function CheckinPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
        </div>
      }
    >
      <CheckinFlow />
    </Suspense>
  );
}
