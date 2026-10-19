import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase-server';

/**
 * POST /api/checkin
 *
 * Public (no staff session). The member identifies with their existing static
 * member token (the same qr_token shown on their profile page), plus the
 * rotating door QR they just scanned and one GPS fix from their phone.
 *
 * Body: { door_qr, member_token, lat, lng, accuracy? }
 *   door_qr: "<branch_id>.<hmac hex>" from the door-mode screen
 *   lat/lng: WGS84 degrees; accuracy: meters (optional)
 *
 * Verification order:
 *   1. door QR signature valid (timing-safe) and fresh (current/previous 30s window)
 *   2. code not already used (replay protection)
 *   3. GPS inside the branch fence — strict mode rejects, lenient mode logs
 *   4. member exists, belongs to the branch's gym, membership not expired
 *   5. no open visit (409 already_checked_in), branch capacity respected
 *   6. insert visit with method='qr' and the submitted coordinates
 */

const WINDOW_SECONDS = 30;
const REPLAY_TTL_SECONDS = 90;

// Simple in-memory rate limiter: 10 check-ins/min per member token.
// (Single-instance dev/small deployments; replace with Redis for multi-instance.)
const rateBuckets = new Map<string, number[]>();
function isRateLimited(key: string): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  const hits = (rateBuckets.get(key) || []).filter((t) => t > windowStart);
  hits.push(now);
  rateBuckets.set(key, hits);
  return hits.length > 10;
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function hmacFor(secret: string, branchId: string, window: number): string {
  return createHmac('sha256', secret).update(`${branchId}:${window}`).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

interface BranchRow {
  id: string;
  gym_id: string;
  name: string;
  door_secret: string;
  checkin_mode: 'lenient' | 'strict';
  geo_lat: number | null;
  geo_lng: number | null;
  geo_radius_m: number;
  max_capacity: number | null;
}

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'A valid JSON object is required' }, { status: 400 });
    }
    const input = body as Record<string, unknown>;

    const doorQr = typeof input.door_qr === 'string' ? input.door_qr.trim() : '';
    const memberToken = typeof input.member_token === 'string' ? input.member_token.trim() : '';
    const lat = typeof input.lat === 'number' ? input.lat : NaN;
    const lng = typeof input.lng === 'number' ? input.lng : NaN;
    const accuracy =
      typeof input.accuracy === 'number' && Number.isFinite(input.accuracy) ? input.accuracy : null;

    if (!doorQr || !/^[0-9a-f-]{36}\.[0-9a-f]{64}$/i.test(doorQr)) {
      return NextResponse.json({ error: 'door_qr must be a valid door code' }, { status: 400 });
    }
    if (!memberToken || memberToken.length > 256) {
      return NextResponse.json({ error: 'member_token is required' }, { status: 400 });
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return NextResponse.json({ error: 'lat/lng must be valid coordinates' }, { status: 400 });
    }
    if (isRateLimited(memberToken)) {
      return NextResponse.json({ error: 'Too many check-in attempts, try again shortly' }, { status: 429 });
    }

    const [branchId, presentedCode] = doorQr.split('.');
    // NOTE: door_*/geo_* columns and door_code_uses come from the door-QR
    // migration and are not in the generated Database types yet — untyped
    // client until `supabase gen types` is re-run.
    const admin = createAdminClient() as unknown as SupabaseClient;

    const { data: branchData, error: branchError } = await admin
      .from('gym_branches')
      .select('id, gym_id, name, door_secret, checkin_mode, geo_lat, geo_lng, geo_radius_m, max_capacity')
      .eq('id', branchId)
      .maybeSingle();
    if (branchError) throw branchError;
    if (!branchData?.door_secret) {
      return NextResponse.json({ error: 'Unknown door code', code: 'code_invalid' }, { status: 400 });
    }
    const branch = branchData as BranchRow;

    // 1. Signature + freshness: accept current or previous window (clock drift).
    const nowWindow = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
    const fresh =
      safeEqual(presentedCode, hmacFor(branch.door_secret, branch.id, nowWindow)) ||
      safeEqual(presentedCode, hmacFor(branch.door_secret, branch.id, nowWindow - 1));
    if (!fresh) {
      return NextResponse.json(
        { error: 'This door code has expired, please scan again', code: 'code_expired' },
        { status: 400 }
      );
    }

    // 2. Replay protection: one scan per code.
    const { data: used } = await admin
      .from('door_code_uses')
      .select('code_hash')
      .eq('code_hash', presentedCode)
      .maybeSingle();
    if (used) {
      return NextResponse.json(
        { error: 'This door code was already used, please scan the fresh code', code: 'code_reused' },
        { status: 400 }
      );
    }
    // Prune entries older than the replay TTL so the table stays tiny.
    await admin
      .from('door_code_uses')
      .delete()
      .lt('used_at', new Date(Date.now() - REPLAY_TTL_SECONDS * 1000).toISOString());

    // 3. GPS fence check.
    let insideFence: boolean | null = null;
    if (branch.geo_lat !== null && branch.geo_lng !== null) {
      const distance = haversineMeters(lat, lng, branch.geo_lat, branch.geo_lng);
      insideFence = distance <= branch.geo_radius_m;
      if (!insideFence && branch.checkin_mode === 'strict') {
        return NextResponse.json(
          {
            error: "We can't confirm you're at the gym — turn on location and try again",
            code: 'outside_gym',
          },
          { status: 403 }
        );
      }
      // lenient mode: log the coordinates and continue.
    }

    // 4. Member lookup + membership status (mirrors the check_in RPC).
    const { data: member, error: memberError } = await admin
      .from('members')
      .select('id, gym_id, member_id, name, status, qr_token')
      .eq('qr_token', memberToken)
      .eq('gym_id', branch.gym_id)
      .maybeSingle();
    if (memberError) throw memberError;
    if (!member) {
      return NextResponse.json({ error: 'Member not found', code: 'member_invalid' }, { status: 404 });
    }
    if (member.status === 'expired') {
      return NextResponse.json(
        { error: 'Membership expired — please renew at the desk', code: 'membership_expired' },
        { status: 403 }
      );
    }

    // 5a. No open visit (a second door scan does NOT check out; checkout is passive).
    const { data: openVisit } = await admin
      .from('visits')
      .select('id')
      .eq('member_id', member.id)
      .is('check_out_at', null)
      .maybeSingle();
    if (openVisit) {
      return NextResponse.json(
        {
          data: { alreadyCheckedIn: true },
          message: 'You are already checked in',
          code: 'already_checked_in',
        },
        { status: 409 }
      );
    }

    // 5b. Capacity.
    if (branch.max_capacity !== null) {
      const { count } = await admin
        .from('visits')
        .select('id', { count: 'exact', head: true })
        .eq('branch_id', branch.id)
        .is('check_out_at', null);
      if ((count ?? 0) >= branch.max_capacity) {
        return NextResponse.json(
          { error: 'The gym is at capacity right now, please wait', code: 'at_capacity' },
          { status: 409 }
        );
      }
    }

    // 6. Record the visit + mark the code used.
    const { data: visit, error: visitError } = await admin
      .from('visits')
      .insert({
        gym_id: branch.gym_id,
        branch_id: branch.id,
        member_id: member.id,
        method: 'qr',
        check_in_lat: lat,
        check_in_lng: lng,
        check_in_accuracy_m: accuracy,
      })
      .select('id, check_in_at, branch_id')
      .single();
    if (visitError) throw visitError;

    await admin.from('door_code_uses').insert({
      code_hash: presentedCode,
      branch_id: branch.id,
      member_id: member.id,
    });

    const { qr_token: _omit, ...safeMember } = member;
    return NextResponse.json(
      {
        data: {
          member: safeMember,
          visit,
          branch_name: branch.name,
          inside_fence: insideFence,
        },
        message: `Checked in at ${branch.name}`,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Door check-in POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
