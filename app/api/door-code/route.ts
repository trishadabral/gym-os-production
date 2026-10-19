import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSession } from '@/lib/session';
import { createUserServerClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase-server';
import { canAccessGymPortal, canAccessStaffApi, isSuperAdminRole } from '@/lib/roles';

/**
 * GET /api/door-code?branch_id=<uuid>
 *
 * Staff-only. Returns the current rotating door QR payload for "door mode":
 * a stateless HMAC_SHA256(branch door_secret, "<branch_id>:<30s window>").
 * The payload embeds the branch id so the check-in route knows which secret
 * to verify against: "<branch_id>.<hmac hex>".
 *
 * The door_secret itself NEVER leaves the server — only the HMAC output.
 * Clients should re-fetch every ~25s (faster than the 30s rotation window).
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canAccessStaffApi(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const userSupabase = createUserServerClient();
    const { searchParams } = new URL(request.url);
    let branchId = searchParams.get('branch_id');

    if (!branchId) {
      branchId = session.homeBranchId;
    }
    if (!branchId && session.gymId) {
      const { data: branch } = await userSupabase
        .from('gym_branches')
        .select('id')
        .eq('gym_id', session.gymId)
        .eq('is_default', true)
        .maybeSingle();
      branchId = branch?.id ?? null;
    }
    if (!branchId) {
      return NextResponse.json({ error: 'branch_id is required' }, { status: 400 });
    }

    // Service-role read: door_secret must never be selectable by RLS user clients.
    // We only return the HMAC output, never the secret itself.
    // NOTE: door_secret/checkin_mode come from the door-QR migration and are not
    // in the generated Database types yet — untyped client until types are re-run.
    const admin = createAdminClient() as unknown as SupabaseClient;
    const { data: branch, error } = await admin
      .from('gym_branches')
      .select('id, gym_id, name, door_secret')
      .eq('id', branchId)
      .maybeSingle();
    if (error) throw error;
    if (!branch) return NextResponse.json({ error: 'Branch not found' }, { status: 404 });

    // Tenant scoping for gym-portal roles (super_admin may target any branch).
    if (canAccessGymPortal(session.role) && !isSuperAdminRole(session.role)) {
      if (!session.gymId || branch.gym_id !== session.gymId) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const window = Math.floor(Date.now() / 1000 / 30);
    const code = createHmac('sha256', branch.door_secret)
      .update(`${branch.id}:${window}`)
      .digest('hex');

    return NextResponse.json({
      data: {
        qr: `${branch.id}.${code}`,
        branch_id: branch.id,
        branch_name: branch.name,
        expires_at: (window + 1) * 30 * 1000,
        server_time: Date.now(),
      },
    });
  } catch (error) {
    console.error('Door code GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
