/**
 * One image, two profiles — selected by PERSONIO_PROFILE:
 *
 *  - "employee" (default): self-service, hard-scoped to the requesting
 *    user's OWN data. The gateway forwards the verified email
 *    (X-MCP-User); the server resolves it to a Personio person id and
 *    pins every tool to that id. Personio's API has no on-behalf-of, so
 *    this scoping is enforced HERE — tools must never accept foreign
 *    person ids in this profile.
 *
 *  - "hr": the HR-admin workbench — company-wide reads; writes require
 *    PERSONIO_ENABLE_WRITES=true on top.
 *
 * Non-negotiable in both profiles: skip_approval is NEVER exposed —
 * absence/attendance writes always run Personio's approval workflow.
 */
export type PersonioProfile = 'employee' | 'hr';

export function profile(): PersonioProfile {
  return process.env.PERSONIO_PROFILE === 'hr' ? 'hr' : 'employee';
}

export function trustForwardedUser(): boolean {
  return process.env.PERSONIO_TRUST_FORWARDED_USER === 'true';
}

export function writesEnabled(): boolean {
  return process.env.PERSONIO_ENABLE_WRITES === 'true';
}

export function assertWritesEnabled(action: string): void {
  if (!writesEnabled()) {
    throw new Error(
      `Write access is disabled on this Personio MCP instance (${action}). ` +
        'Set PERSONIO_ENABLE_WRITES=true in the server environment to allow HR write tools.',
    );
  }
}

const EMPLOYEE_TOOLS = new Set([
  'personio_search_capabilities',
  'personio_whoami',
  'personio_get_my_profile',
  'personio_get_my_absences',
  'personio_request_absence',
  'personio_get_my_attendances',
  'personio_record_attendance',
  'personio_get_my_documents',
  'personio_list_projects',
  'personio_list_absence_types',
]);

const HR_TOOLS = new Set([
  'personio_search_capabilities',
  'personio_whoami',
  'personio_list_persons',
  'personio_get_person',
  'personio_update_person',
  'personio_list_absences',
  'personio_manage_absence',
  'personio_list_attendances',
  'personio_manage_attendance',
  'personio_list_absence_types',
  'personio_list_projects',
  'personio_manage_project',
  'personio_list_compensations',
  'personio_list_documents',
  'personio_upload_document',
  'personio_list_org_data',
  'personio_get_custom_report',
  'personio_list_recruiting',
  'personio_list_attributes',
]);

export interface PersonioPolicyDecision {
  allowed: boolean;
  reason: string;
}

const WRITE_TOOLS = new Set([
  'personio_update_person',
  'personio_manage_absence',
  'personio_manage_attendance',
  'personio_manage_project',
  'personio_upload_document',
]);

export function checkToolPolicy(toolName: string): PersonioPolicyDecision {
  const tools = profile() === 'hr' ? HR_TOOLS : EMPLOYEE_TOOLS;
  if (!tools.has(toolName)) {
    if (HR_TOOLS.has(toolName) || EMPLOYEE_TOOLS.has(toolName)) {
      return { allowed: false, reason: `tool is not available in the ${profile()} profile: ${toolName}` };
    }
    return { allowed: false, reason: `tool is not allowlisted: ${toolName}` };
  }
  if (profile() === 'hr' && WRITE_TOOLS.has(toolName) && !writesEnabled()) {
    return {
      allowed: false,
      reason: `write tool is disabled on this instance (PERSONIO_ENABLE_WRITES != true): ${toolName}`,
    };
  }
  return { allowed: true, reason: `allowed in ${profile()} profile` };
}

/**
 * Tools that can expose employees OUTSIDE the instance's legal entity and
 * cannot be safely confined server-side (custom reports bypass the
 * attribute whitelist; recruiting isn't legal-entity scoped). They are
 * dropped on a legal-entity-scoped HR instance.
 */
const CROSS_ENTITY_LEAK_TOOLS = new Set(['personio_get_custom_report', 'personio_list_recruiting']);

export function toolNamesForProfile(): Set<string> {
  if (profile() !== 'hr') {
    return EMPLOYEE_TOOLS;
  }
  if (!process.env.PERSONIO_HR_LEGAL_ENTITY || process.env.PERSONIO_HR_LEGAL_ENTITY.trim().toLowerCase() === 'all') {
    return HR_TOOLS;
  }
  return new Set([...HR_TOOLS].filter(t => !CROSS_ENTITY_LEAK_TOOLS.has(t)));
}
