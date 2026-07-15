import type { PersonioClient, QueryValue } from './client.js';
import { assertWritesEnabled } from './policy.js';

/**
 * v2 lists are cursor-paginated: {_data, _meta.links.next}. Tools accept
 * `cursor` and return it back out. Per-endpoint limit caps differ (persons
 * 50, documents 200, most org data 100) — we clamp per call site.
 */
export interface CursorInput {
  limit?: number;
  cursor?: string;
}

function page(input: CursorInput, cap: number, defaultLimit = Math.min(50, cap)): Record<string, QueryValue> {
  return {
    limit: Math.min(input.limit ?? defaultLimit, cap),
    cursor: input.cursor,
  };
}

// --- Persons / employments ---

export interface ListPersonsInput extends CursorInput {
  email?: string;
  firstName?: string;
  lastName?: string;
  status?: 'ACTIVE' | 'INACTIVE';
  updatedAfter?: string;
}

export async function listPersons(client: PersonioClient, input: ListPersonsInput = {}): Promise<unknown> {
  return client.get('/v2/persons', {
    ...page(input, 50),
    email: input.email,
    first_name: input.firstName,
    last_name: input.lastName,
    status: input.status,
    'updated_at.gt': input.updatedAfter,
  });
}

export async function getPerson(
  client: PersonioClient,
  input: { personId: string; includeEmployments?: boolean },
): Promise<unknown> {
  const person = await client.get(`/v2/persons/${encodeURIComponent(input.personId)}`);
  if (!input.includeEmployments) {
    return person;
  }
  const employments = await client.get(`/v2/persons/${encodeURIComponent(input.personId)}/employments`);
  return { person, employments };
}

export async function updatePerson(
  client: PersonioClient,
  input: { personId: string; patch: Record<string, unknown> },
): Promise<unknown> {
  assertWritesEnabled('personio_update_person');
  return client.patch(`/v2/persons/${encodeURIComponent(input.personId)}`, input.patch);
}

// --- Absences ---

export interface ListAbsencesInput extends CursorInput {
  personId?: string;
  startsAfter?: string;
  endsBefore?: string;
}

export async function listAbsences(client: PersonioClient, input: ListAbsencesInput = {}): Promise<unknown> {
  return client.get('/v2/absence-periods', {
    ...page(input, 100),
    'person.id': input.personId,
    'starts_from.date.gte': input.startsAfter,
    'ends_at.date.lte': input.endsBefore,
  });
}

export interface CreateAbsenceInput {
  personId: string;
  absenceTypeId: string;
  startDate: string;
  startHalf?: 'FIRST_HALF' | 'SECOND_HALF';
  endDate?: string;
  endHalf?: 'FIRST_HALF' | 'SECOND_HALF';
  comment?: string;
}

/**
 * Creates an absence period. skip_approval is deliberately never sent —
 * v2 defaults to false, so the request enters Personio's normal approval
 * workflow. There is no API to approve pending requests (UI only).
 */
export async function createAbsence(client: PersonioClient, input: CreateAbsenceInput): Promise<unknown> {
  return client.post('/v2/absence-periods', {
    person: { id: input.personId },
    absence_type: { id: input.absenceTypeId },
    starts_from: {
      date: input.startDate,
      ...(input.startHalf ? { type: input.startHalf } : {}),
    },
    ...(input.endDate
      ? { ends_at: { date: input.endDate, ...(input.endHalf ? { type: input.endHalf } : {}) } }
      : {}),
    ...(input.comment ? { comment: input.comment } : {}),
  });
}

export async function deleteAbsence(client: PersonioClient, input: { absencePeriodId: string }): Promise<unknown> {
  return client.delete(`/v2/absence-periods/${encodeURIComponent(input.absencePeriodId)}`);
}

export async function listAbsenceTypes(client: PersonioClient, input: CursorInput = {}): Promise<unknown> {
  return client.get('/v2/absence-types', page(input, 100));
}

/** Absence balances exist only in v1 — resolve the numeric employee id by email. */
export async function getAbsenceBalance(client: PersonioClient, email: string): Promise<unknown> {
  const lookup = await client.get<{ data?: Array<{ attributes?: { id?: { value?: number } } }> }>(
    '/company/employees',
    { email },
  );
  const employeeId = lookup.data?.[0]?.attributes?.id?.value;
  if (!employeeId) {
    throw new Error(`No v1 employee found for ${email} — cannot fetch absence balance.`);
  }
  return client.get(`/company/employees/${employeeId}/absences/balance`);
}

// --- Attendances (v2: WORK and BREAK are separate periods) ---

export interface ListAttendancesInput extends CursorInput {
  personId?: string;
  startsAfter?: string;
  endsBefore?: string;
}

export async function listAttendances(client: PersonioClient, input: ListAttendancesInput = {}): Promise<unknown> {
  return client.get('/v2/attendance-periods', {
    ...page(input, 100),
    'person.id': input.personId,
    'starts_from.gte': input.startsAfter,
    'ends_at.lte': input.endsBefore,
  });
}

export interface CreateAttendanceInput {
  personId: string;
  type: 'WORK' | 'BREAK';
  start: string;
  end: string;
  projectId?: string;
  comment?: string;
}

/** skip_approval is never sent — the approval workflow always applies. */
export async function createAttendance(client: PersonioClient, input: CreateAttendanceInput): Promise<unknown> {
  if (input.projectId && input.type === 'BREAK') {
    throw new Error('Projects can only be set on WORK periods, not BREAK.');
  }
  return client.post('/v2/attendance-periods', {
    person: { id: input.personId },
    type: input.type,
    start: { date_time: input.start },
    end: { date_time: input.end },
    ...(input.projectId ? { project: { id: input.projectId } } : {}),
    ...(input.comment ? { comment: input.comment } : {}),
  });
}

export async function deleteAttendance(
  client: PersonioClient,
  input: { attendancePeriodId: string },
): Promise<unknown> {
  return client.delete(`/v2/attendance-periods/${encodeURIComponent(input.attendancePeriodId)}`);
}

// --- Projects ---

export async function listProjects(client: PersonioClient, input: CursorInput = {}): Promise<unknown> {
  return client.get('/v2/projects', page(input, 100));
}

export interface ManageProjectInput {
  action: 'create' | 'update' | 'delete' | 'add-member' | 'remove-member';
  projectId?: string;
  payload?: Record<string, unknown>;
  personId?: string;
}

export async function manageProject(client: PersonioClient, input: ManageProjectInput): Promise<unknown> {
  assertWritesEnabled('personio_manage_project');
  const id = input.projectId ? encodeURIComponent(input.projectId) : undefined;
  switch (input.action) {
    case 'create':
      return client.post('/v2/projects', input.payload ?? {});
    case 'update':
      requireId(id, 'update');
      return client.patch(`/v2/projects/${id}`, input.payload ?? {});
    case 'delete':
      requireId(id, 'delete');
      return client.delete(`/v2/projects/${id}`);
    case 'add-member':
      requireId(id, 'add-member');
      if (!input.personId) {
        throw new Error('personId is required for add-member.');
      }
      return client.post(`/v2/projects/${id}/members`, { person: { id: input.personId } });
    case 'remove-member':
      requireId(id, 'remove-member');
      if (!input.personId) {
        throw new Error('personId is required for remove-member.');
      }
      return client.delete(`/v2/projects/${id}/members`, { 'person.id': input.personId });
    default:
      throw new Error(`Unknown project action: ${String(input.action)}`);
  }
}

function requireId(id: string | undefined, action: string): asserts id is string {
  if (!id) {
    throw new Error(`projectId is required for ${action}.`);
  }
}

// --- Documents ---

export interface ListDocumentsInput extends CursorInput {
  ownerId: string;
  categoryId?: string;
  documentId?: string;
  download?: boolean;
  maxBytes?: number;
}

const DOWNLOAD_CAP_DEFAULT = 2 * 1024 * 1024;
const DOWNLOAD_CAP_MAX = 20 * 1024 * 1024;

export async function listDocuments(client: PersonioClient, input: ListDocumentsInput): Promise<unknown> {
  if (input.documentId && input.download) {
    const maxBytes = Math.min(input.maxBytes ?? DOWNLOAD_CAP_DEFAULT, DOWNLOAD_CAP_MAX);
    const { bytes, contentType } = await client.getBinary(
      `/v2/document-management/documents/${encodeURIComponent(input.documentId)}/download`,
      maxBytes,
    );
    const isText = /^(text\/|application\/(json|xml|csv))/.test(contentType);
    return {
      contentType,
      sizeBytes: bytes.byteLength,
      encoding: isText ? 'utf-8' : 'base64',
      content: isText ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString('base64'),
    };
  }
  return client.get('/v2/document-management/documents', {
    ...page(input, 200, 100),
    owner_id: input.ownerId,
    category_id: input.categoryId,
  });
}

export interface UploadDocumentInput {
  employeeId: number;
  categoryId: number;
  title: string;
  fileName: string;
  contentBase64: string;
  mimeType?: string;
  comment?: string;
  date?: string;
}

/** Upload has no v2 endpoint — this is the v1 multipart flow. */
export async function uploadDocument(client: PersonioClient, input: UploadDocumentInput): Promise<unknown> {
  assertWritesEnabled('personio_upload_document');
  return client.postMultipartV1(
    '/company/documents',
    {
      employee_id: input.employeeId,
      category_id: input.categoryId,
      title: input.title,
      comment: input.comment,
      date: input.date,
    },
    {
      fieldName: 'file',
      fileName: input.fileName,
      contentBase64: input.contentBase64,
      mimeType: input.mimeType,
    },
  );
}

// --- Compensation (read-only: API-created entries cannot be updated or deleted) ---

export interface ListCompensationsInput extends CursorInput {
  scope: 'entries' | 'types' | 'jobs' | 'salary-bands';
  personId?: string;
  legalEntityId?: string;
  /** entries require a window of max 1 month. */
  startDate?: string;
  endDate?: string;
}

export async function listCompensations(client: PersonioClient, input: ListCompensationsInput): Promise<unknown> {
  switch (input.scope) {
    case 'entries':
      if (!input.startDate || !input.endDate) {
        throw new Error('startDate and endDate are required for compensation entries (max 1 month window).');
      }
      return client.get('/v2/compensations', {
        ...page(input, 100),
        start_date: input.startDate,
        end_date: input.endDate,
        'person.id': input.personId,
        'legal_entity.id': input.legalEntityId,
      });
    case 'types':
      return client.get('/v2/compensations/types', page(input, 100));
    case 'jobs':
      return client.get('/v2/jobs', page(input, 100));
    case 'salary-bands':
      return client.get('/v2/salary-bands', page(input, 100));
    default:
      throw new Error(`Unknown compensation scope: ${String(input.scope)}`);
  }
}

// --- Org data (read-only) ---

export interface ListOrgDataInput extends CursorInput {
  kind: 'legal-entities' | 'departments' | 'teams' | 'cost-centers' | 'workplaces';
}

export async function listOrgData(client: PersonioClient, input: ListOrgDataInput): Promise<unknown> {
  switch (input.kind) {
    case 'legal-entities':
      return client.get('/v2/legal-entities', page(input, 100, 20));
    case 'departments':
      return client.get('/v2/org-units', { ...page(input, 100, 20), type: 'department' }, { beta: true });
    case 'teams':
      return client.get('/v2/org-units', { ...page(input, 100, 20), type: 'team' }, { beta: true });
    case 'cost-centers':
      return client.get('/v2/cost-centers', page(input, 100, 50), { beta: true });
    case 'workplaces':
      return client.get('/v2/workplaces', page(input, 100, 50), { beta: true });
    default:
      throw new Error(`Unknown org data kind: ${String(input.kind)}`);
  }
}

// --- Reports ---

export interface GetReportInput extends CursorInput {
  reportId?: string;
  locale?: string;
  listAttributes?: boolean;
}

export async function getReport(client: PersonioClient, input: GetReportInput = {}): Promise<unknown> {
  if (input.listAttributes) {
    return client.get('/v2/reports/attributes', page(input, 100));
  }
  if (input.reportId) {
    return client.get(`/v2/reports/${encodeURIComponent(input.reportId)}`, {
      limit: input.limit,
      cursor: input.cursor,
      locale: input.locale,
    });
  }
  return client.get('/v2/reports', page(input, 100));
}

// --- Recruiting (v2 read-only, Beta) ---

export interface ListRecruitingInput extends CursorInput {
  kind: 'applications' | 'candidates' | 'jobs' | 'categories';
  id?: string;
  candidateEmail?: string;
  updatedAfter?: string;
}

export async function listRecruiting(client: PersonioClient, input: ListRecruitingInput): Promise<unknown> {
  const base = `/v2/recruiting/${input.kind}`;
  if (input.id) {
    return client.get(`${base}/${encodeURIComponent(input.id)}`, undefined, { beta: true });
  }
  return client.get(
    base,
    {
      ...page(input, 100, 20),
      ...(input.kind === 'applications'
        ? { 'candidate.email': input.candidateEmail, 'updated_at.gt': input.updatedAfter }
        : {}),
    },
    { beta: true },
  );
}

// --- Diagnostics ---

/** v1 attribute schema — shows exactly what the credential's whitelist exposes. */
export async function listAttributes(client: PersonioClient): Promise<unknown> {
  return client.get('/company/employees/attributes');
}
