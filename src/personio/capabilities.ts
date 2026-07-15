export type CapabilityRisk = 'read' | 'write';

export interface PersonioCapability {
  id: string;
  title: string;
  description: string;
  risk: CapabilityRisk;
  examples: unknown[];
  identifierFormats: string[];
  safetyNotes: string[];
  keywords: string[];
}

export const READ_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const SELF_NOTE = 'Scoped to YOUR OWN data — the server resolves your identity from the gateway and pins every call to your person id.';
const APPROVAL_NOTE = 'Always enters Personio’s normal approval workflow — approval bypass is not possible through this server.';
const CURSOR_NOTE = 'Cursor pagination: pass the returned cursor back to continue.';

export const PERSONIO_CAPABILITIES: PersonioCapability[] = [
  {
    id: 'personio_search_capabilities',
    title: 'Search Personio Capabilities',
    description: 'Find the Personio MCP tool for HR data, absence, time tracking, documents, or recruiting.',
    risk: 'read',
    examples: [{ query: 'ferie' }],
    identifierFormats: ['Tool id such as personio_request_absence.'],
    safetyNotes: ['Discovery only.'],
    keywords: ['discover', 'help', 'capabilities'],
  },
  {
    id: 'personio_whoami',
    title: 'Who Am I (Personio)',
    description: 'Show which Personio person this session is scoped to.',
    risk: 'read',
    examples: [{}],
    identifierFormats: [],
    safetyNotes: [SELF_NOTE],
    keywords: ['me', 'identity', 'hvem'],
  },
  {
    id: 'personio_get_my_profile',
    title: 'My Profile (Personio)',
    description: 'Your own HR master data and employment (position, department, supervisor, dates).',
    risk: 'read',
    examples: [{}],
    identifierFormats: [],
    safetyNotes: [SELF_NOTE, 'Only attributes whitelisted on the API credential are returned.'],
    keywords: ['profile', 'stamdata', 'ansættelse', 'min side'],
  },
  {
    id: 'personio_get_my_absences',
    title: 'My Absences (Personio)',
    description: 'Your absence periods (vacation, sick leave, …) and, with includeBalance, your remaining balances per absence type.',
    risk: 'read',
    examples: [{}, { includeBalance: true }],
    identifierFormats: ['Dates as YYYY-MM-DD'],
    safetyNotes: [SELF_NOTE],
    keywords: ['ferie', 'fravær', 'absence', 'sygdom', 'saldo', 'balance', 'restferie'],
  },
  {
    id: 'personio_request_absence',
    title: 'Request Absence (Personio)',
    description: 'Submit an absence request (vacation, etc.) for yourself. Supports half days and open-ended periods.',
    risk: 'write',
    examples: [{ absenceTypeId: '123', startDate: '2026-08-03', endDate: '2026-08-14' }],
    identifierFormats: ['absenceTypeId from personio_list_absence_types'],
    safetyNotes: [SELF_NOTE, APPROVAL_NOTE],
    keywords: ['ferie', 'anmod', 'request', 'fravær', 'vacation', 'orlov'],
  },
  {
    id: 'personio_get_my_attendances',
    title: 'My Attendances (Personio)',
    description: 'Your tracked work and break periods.',
    risk: 'read',
    examples: [{ startsAfter: '2026-07-01' }],
    identifierFormats: [],
    safetyNotes: [SELF_NOTE],
    keywords: ['tid', 'timer', 'time tracking', 'arbejdstid', 'attendance'],
  },
  {
    id: 'personio_record_attendance',
    title: 'Record Attendance (Personio)',
    description: 'Record a work or break period for yourself, optionally tagged with a project.',
    risk: 'write',
    examples: [{ type: 'WORK', start: '2026-07-15T08:00:00Z', end: '2026-07-15T12:00:00Z', projectId: '7' }],
    identifierFormats: ['Timestamps as ISO 8601; breaks are separate BREAK periods, not minutes'],
    safetyNotes: [SELF_NOTE, APPROVAL_NOTE, 'Max 24 hours per period.'],
    keywords: ['registrer', 'tid', 'timer', 'stemple', 'projekt', 'pause'],
  },
  {
    id: 'personio_get_my_documents',
    title: 'My Documents (Personio)',
    description: 'Your HR documents (contracts, certificates) with e-signature status; download by documentId.',
    risk: 'read',
    examples: [{}, { documentId: 'abc', download: true }],
    identifierFormats: [],
    safetyNotes: [SELF_NOTE, 'Downloads capped at 2 MB by default (maxBytes up to 20 MB).'],
    keywords: ['dokumenter', 'kontrakt', 'documents', 'esignature', 'underskrift'],
  },
  {
    id: 'personio_list_absence_types',
    title: 'List Absence Types (Personio)',
    description: 'Available absence types (vacation, sick, parental leave, …) and their ids.',
    risk: 'read',
    examples: [{}],
    identifierFormats: [],
    safetyNotes: [],
    keywords: ['fraværstyper', 'absence types', 'ferietype'],
  },
  {
    id: 'personio_list_projects',
    title: 'List Projects (Personio)',
    description: 'Time-tracking projects (for tagging attendance periods).',
    risk: 'read',
    examples: [{}],
    identifierFormats: [],
    safetyNotes: [CURSOR_NOTE],
    keywords: ['projekter', 'projects', 'time tracking'],
  },
  {
    id: 'personio_list_persons',
    title: 'List Persons (Personio, HR)',
    description: 'Company-wide person list with filters: email, name, status, updated-since.',
    risk: 'read',
    examples: [{ status: 'ACTIVE' }, { email: 'x@y.dk' }],
    identifierFormats: [],
    safetyNotes: [CURSOR_NOTE, 'Only whitelisted attributes are returned (see personio_list_attributes).'],
    keywords: ['medarbejdere', 'employees', 'persons', 'ansatte', 'liste'],
  },
  {
    id: 'personio_get_person',
    title: 'Get Person (Personio, HR)',
    description: 'One person’s full profile, optionally with employments (legal entity, org unit, supervisor, dates).',
    risk: 'read',
    examples: [{ personId: '42', includeEmployments: true }],
    identifierFormats: ['personId from personio_list_persons'],
    safetyNotes: [],
    keywords: ['person', 'medarbejder', 'profil', 'ansættelse'],
  },
  {
    id: 'personio_update_person',
    title: 'Update Person (Personio, HR)',
    description: 'Update a person’s master data incl. custom attributes. Requires write access on this instance.',
    risk: 'write',
    examples: [{ personId: '42', patch: { preferred_name: 'Bo' } }],
    identifierFormats: ['custom_attributes: [{id, value}]'],
    safetyNotes: ['Requires PERSONIO_ENABLE_WRITES=true. Email cannot be changed via API. No delete tool exists by design.'],
    keywords: ['ret', 'update', 'stamdata', 'attributes'],
  },
  {
    id: 'personio_list_absences',
    title: 'List Absences (Personio, HR)',
    description: 'Absence periods across the company, filterable by person and date range. With balanceForEmail, returns that person’s absence balances instead.',
    risk: 'read',
    examples: [{ startsAfter: '2026-07-01' }, { personId: '42' }],
    identifierFormats: [],
    safetyNotes: [CURSOR_NOTE],
    keywords: ['fravær', 'ferie', 'absence', 'oversigt', 'hvem er væk'],
  },
  {
    id: 'personio_manage_absence',
    title: 'Manage Absence (Personio, HR)',
    description: 'Create an absence for any person, or delete an absence period. Requires write access.',
    risk: 'write',
    examples: [{ action: 'create', personId: '42', absenceTypeId: '1', startDate: '2026-08-01', endDate: '2026-08-05' }],
    identifierFormats: ['action: create | delete'],
    safetyNotes: ['Requires PERSONIO_ENABLE_WRITES=true.', APPROVAL_NOTE, 'Pending requests cannot be approved via API (UI only).'],
    keywords: ['fravær', 'opret', 'slet', 'absence', 'manage'],
  },
  {
    id: 'personio_list_attendances',
    title: 'List Attendances (Personio, HR)',
    description: 'Attendance periods across the company, filterable by person and date range.',
    risk: 'read',
    examples: [{ personId: '42', startsAfter: '2026-07-01' }],
    identifierFormats: [],
    safetyNotes: [CURSOR_NOTE],
    keywords: ['tid', 'timer', 'attendance', 'arbejdstid', 'oversigt'],
  },
  {
    id: 'personio_manage_attendance',
    title: 'Manage Attendance (Personio, HR)',
    description: 'Create or delete an attendance period for any person. Requires write access.',
    risk: 'write',
    examples: [{ action: 'create', personId: '42', type: 'WORK', start: '2026-07-15T08:00:00Z', end: '2026-07-15T16:00:00Z' }],
    identifierFormats: ['action: create | delete'],
    safetyNotes: ['Requires PERSONIO_ENABLE_WRITES=true.', APPROVAL_NOTE],
    keywords: ['tid', 'registrer', 'ret', 'attendance', 'manage'],
  },
  {
    id: 'personio_manage_project',
    title: 'Manage Projects (Personio, HR)',
    description: 'Create/update/delete time-tracking projects and manage their members. Requires write access.',
    risk: 'write',
    examples: [{ action: 'create', payload: { name: 'Nedrivning Xvej' } }, { action: 'add-member', projectId: '7', personId: '42' }],
    identifierFormats: ['action: create | update | delete | add-member | remove-member'],
    safetyNotes: ['Requires PERSONIO_ENABLE_WRITES=true.'],
    keywords: ['projekt', 'opret', 'medlemmer', 'project'],
  },
  {
    id: 'personio_list_compensations',
    title: 'List Compensation (Personio, HR)',
    description: 'Compensation entries (salary, bonus payouts — scope=entries, max 1 month window), compensation types, job catalog, or salary bands.',
    risk: 'read',
    examples: [{ scope: 'entries', startDate: '2026-07-01', endDate: '2026-07-31' }, { scope: 'salary-bands' }],
    identifierFormats: ['scope: entries | types | jobs | salary-bands'],
    safetyNotes: ['READ-ONLY by design: API-created compensation entries can never be updated or deleted, so creation is not exposed.'],
    keywords: ['løn', 'compensation', 'salary', 'bonus', 'lønbånd'],
  },
  {
    id: 'personio_list_documents',
    title: 'List/Download Documents (Personio, HR)',
    description: 'Documents for any employee (ownerId required), incl. e-signature status; download by documentId.',
    risk: 'read',
    examples: [{ ownerId: '42' }],
    identifierFormats: [],
    safetyNotes: ['Payroll/DATEV documents are excluded by the API.'],
    keywords: ['dokumenter', 'documents', 'kontrakter', 'download'],
  },
  {
    id: 'personio_upload_document',
    title: 'Upload Document (Personio, HR)',
    description: 'Upload a document to an employee profile (v1 flow — requires the numeric employee id and category id). Requires write access.',
    risk: 'write',
    examples: [{ employeeId: 1234, categoryId: 1, title: 'Ansættelseskontrakt', fileName: 'kontrakt.pdf', contentBase64: '…' }],
    identifierFormats: [],
    safetyNotes: ['Requires PERSONIO_ENABLE_WRITES=true. E-signature flows cannot be initiated via API.'],
    keywords: ['upload', 'dokument', 'kontrakt', 'bilag'],
  },
  {
    id: 'personio_list_org_data',
    title: 'List Org Data (Personio, HR)',
    description: 'Legal entities (selskaber), departments, teams, cost centers, or workplaces. Read-only.',
    risk: 'read',
    examples: [{ kind: 'legal-entities' }, { kind: 'departments' }],
    identifierFormats: ['kind: legal-entities | departments | teams | cost-centers | workplaces'],
    safetyNotes: [],
    keywords: ['selskaber', 'legal entities', 'afdelinger', 'teams', 'organisation'],
  },
  {
    id: 'personio_get_custom_report',
    title: 'Custom Reports (Personio, HR)',
    description: 'List custom reports, fetch a report’s data by id, or list available report attributes (analytics).',
    risk: 'read',
    examples: [{}, { reportId: 'uuid' }],
    identifierFormats: [],
    safetyNotes: ['Report data can include attributes beyond the credential whitelist — treat as HR-sensitive.'],
    keywords: ['rapport', 'analytics', 'custom report', 'analyse'],
  },
  {
    id: 'personio_list_recruiting',
    title: 'Recruiting (Personio, HR)',
    description: 'Read applications (filter by candidate email), candidates, published jobs, and categories. Read-only — stage moves happen in the Personio UI.',
    risk: 'read',
    examples: [{ kind: 'applications' }, { kind: 'candidates', id: 'abc' }],
    identifierFormats: ['kind: applications | candidates | jobs | categories'],
    safetyNotes: ['Beta API; custom attributes/tags are not returned yet.'],
    keywords: ['rekruttering', 'ansøgninger', 'kandidater', 'recruiting', 'jobs'],
  },
  {
    id: 'personio_list_attributes',
    title: 'List Attribute Whitelist (Personio, HR)',
    description: 'Diagnostic: which employee attributes the API credential can read. Attributes missing here are silently omitted from person data.',
    risk: 'read',
    examples: [{}],
    identifierFormats: [],
    safetyNotes: [],
    keywords: ['attributter', 'whitelist', 'schema', 'felter', 'diagnostik'],
  },
];

export function searchCapabilities(query: string, limit = 20, available?: Set<string>): PersonioCapability[] {
  const pool = available
    ? PERSONIO_CAPABILITIES.filter(capability => available.has(capability.id))
    : PERSONIO_CAPABILITIES;
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return pool.slice(0, limit);
  }
  return pool
    .map(capability => ({ capability, score: scoreCapability(capability, normalized) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id))
    .slice(0, limit)
    .map(item => item.capability);
}

function scoreCapability(capability: PersonioCapability, query: string): number {
  const haystack = [
    capability.id,
    capability.title,
    capability.description,
    ...capability.identifierFormats,
    ...capability.keywords,
  ]
    .join(' ')
    .toLowerCase();
  return query
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}
