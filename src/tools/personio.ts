import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { formatUnknownError } from '../errors.js';
import { writeAuditEvent } from '../personio/audit.js';
import {
  READ_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  searchCapabilities,
} from '../personio/capabilities.js';
import type { PersonioClient } from '../personio/client.js';
import { resolvePerson, type ResolvedPerson } from '../personio/identity.js';
import { checkToolPolicy, profile, toolNamesForProfile } from '../personio/policy.js';
import { hrLegalEntity, LegalEntityScope } from '../personio/scope.js';
import {
  createAbsence,
  createAttendance,
  deleteAbsence,
  deleteAttendance,
  getAbsenceBalance,
  getPerson,
  getReport,
  listAbsences,
  listAbsenceTypes,
  listAttendances,
  listAttributes,
  listCompensations,
  listDocuments,
  listOrgData,
  listPersons,
  listProjects,
  listRecruiting,
  manageProject,
  updatePerson,
  uploadDocument,
} from '../personio/resources.js';

export interface RegisterOptions {
  /** Gateway-verified email of the requesting user (employee profile requires it). */
  onBehalfOf?: string;
}

const cursorShape = {
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().trim().optional(),
};
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const halfSchema = z.enum(['FIRST_HALF', 'SECOND_HALF']).optional();

export function registerPersonioTools(server: McpServer, client: PersonioClient, options: RegisterOptions = {}): void {
  const available = toolNamesForProfile();
  const employee = profile() === 'employee';

  let resolvedPromise: Promise<ResolvedPerson> | undefined;
  const self = (): Promise<ResolvedPerson> => {
    if (!options.onBehalfOf) {
      throw new Error(
        'No requesting user identity available. The employee profile requires the gateway to forward the verified user (X-MCP-User).',
      );
    }
    resolvedPromise ??= resolvePerson(client, options.onBehalfOf);
    return resolvedPromise;
  };

  // Legal-entity scoping (HR profile only): confine every person-addressed
  // tool to employees of one legal entity. Enforced here because Personio's
  // API has no legal-entity filter on most endpoints.
  const entityId = profile() === 'hr' ? hrLegalEntity() : undefined;
  const scope = entityId ? new LegalEntityScope(client, entityId) : undefined;
  const rows = (data: unknown): Array<Record<string, unknown>> =>
    Array.isArray((data as { _data?: unknown })?._data) ? ((data as { _data: Array<Record<string, unknown>> })._data) : [];

  const register: typeof server.registerTool = (name, config, handler) => {
    if (!available.has(name)) {
      return undefined as never;
    }
    return server.registerTool(name, config, handler);
  };

  register(
    'personio_search_capabilities',
    {
      title: 'Search Personio Capabilities',
      description: 'Search the Personio MCP server capabilities and examples. Use this first when deciding which tool to call.',
      inputSchema: {
        query: z.string().trim().default(''),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_search_capabilities', options, input, async () =>
        jsonResult(searchCapabilities(input.query, input.limit, available)),
      ),
  );

  register(
    'personio_whoami',
    {
      title: 'Who Am I (Personio)',
      description: 'Show which Personio person this session is scoped to.',
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_whoami', options, input, async () => {
        if (employee) {
          return jsonResult(await self());
        }
        return jsonResult({
          profile: 'hr',
          actingAs: options.onBehalfOf ?? '(gateway identity not forwarded)',
          note: 'HR profile: company-wide access with the API credential; requests are audited per user.',
        });
      }),
  );

  // --- Employee self-service ---

  register(
    'personio_get_my_profile',
    {
      title: 'My Profile (Personio)',
      description: 'Your own HR master data and employment. Only credential-whitelisted attributes are returned.',
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_get_my_profile', options, input, async () => {
        const me = await self();
        return jsonResult(await getPerson(client, { personId: me.personId, includeEmployments: true }));
      }),
  );

  register(
    'personio_get_my_absences',
    {
      title: 'My Absences (Personio)',
      description: 'Your absence periods; includeBalance=true also returns your remaining balance per absence type.',
      inputSchema: {
        startsAfter: dateSchema.optional(),
        endsBefore: dateSchema.optional(),
        includeBalance: z.boolean().default(false),
        ...cursorShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_get_my_absences', options, input, async () => {
        const me = await self();
        const absences = await listAbsences(client, { ...input, personId: me.personId });
        if (!input.includeBalance) {
          return jsonResult(absences);
        }
        const balance = await getAbsenceBalance(client, me.email).catch((error: unknown) => ({
          error: formatUnknownError(error),
        }));
        return jsonResult({ absences, balance });
      }),
  );

  register(
    'personio_request_absence',
    {
      title: 'Request Absence (Personio)',
      description:
        'Submit an absence request for yourself (vacation etc.). Half days via startHalf/endHalf; omit endDate for open-ended. Always goes through the normal approval workflow.',
      inputSchema: {
        absenceTypeId: z.string().trim().min(1),
        startDate: dateSchema,
        startHalf: halfSchema,
        endDate: dateSchema.optional(),
        endHalf: halfSchema,
        comment: z.string().trim().optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_request_absence', options, input, async () => {
        const me = await self();
        return jsonResult(await createAbsence(client, { ...input, personId: me.personId }));
      }),
  );

  register(
    'personio_get_my_attendances',
    {
      title: 'My Attendances (Personio)',
      description: 'Your tracked work and break periods.',
      inputSchema: {
        startsAfter: z.string().trim().optional(),
        endsBefore: z.string().trim().optional(),
        ...cursorShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_get_my_attendances', options, input, async () => {
        const me = await self();
        return jsonResult(await listAttendances(client, { ...input, personId: me.personId }));
      }),
  );

  register(
    'personio_record_attendance',
    {
      title: 'Record Attendance (Personio)',
      description:
        'Record a WORK or BREAK period for yourself (breaks are separate periods). WORK periods can be tagged with a projectId. Goes through the approval workflow; max 24h per period.',
      inputSchema: {
        type: z.enum(['WORK', 'BREAK']),
        start: z.string().trim().min(10).describe('ISO 8601 start, e.g. 2026-07-15T08:00:00Z'),
        end: z.string().trim().min(10),
        projectId: z.string().trim().optional(),
        comment: z.string().trim().optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_record_attendance', options, input, async () => {
        const me = await self();
        return jsonResult(await createAttendance(client, { ...input, personId: me.personId }));
      }),
  );

  register(
    'personio_get_my_documents',
    {
      title: 'My Documents (Personio)',
      description: 'Your HR documents with e-signature status; set documentId+download=true to fetch content.',
      inputSchema: {
        categoryId: z.string().trim().optional(),
        documentId: z.string().trim().optional(),
        download: z.boolean().default(false),
        maxBytes: z.number().int().min(1).max(20 * 1024 * 1024).optional(),
        ...cursorShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_get_my_documents', options, input, async () => {
        const me = await self();
        return jsonResult(await listDocuments(client, { ...input, ownerId: me.personId }));
      }),
  );

  // --- Shared reference reads ---

  register(
    'personio_list_absence_types',
    {
      title: 'List Absence Types (Personio)',
      description: 'Available absence types and their ids (needed for absence requests).',
      inputSchema: { ...cursorShape },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_list_absence_types', options, input, async () => jsonResult(await listAbsenceTypes(client, input))),
  );

  register(
    'personio_list_projects',
    {
      title: 'List Projects (Personio)',
      description: 'Time-tracking projects (for tagging attendance).',
      inputSchema: { ...cursorShape },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_list_projects', options, input, async () => jsonResult(await listProjects(client, input))),
  );

  // --- HR profile ---

  register(
    'personio_list_persons',
    {
      title: 'List Persons (Personio, HR)',
      description: 'Company-wide person list. Filters: email (exact), firstName, lastName, status, updatedAfter.',
      inputSchema: {
        email: z.string().trim().email().optional(),
        firstName: z.string().trim().optional(),
        lastName: z.string().trim().optional(),
        status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
        updatedAfter: z.string().trim().optional(),
        ...cursorShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_list_persons', options, input, async () => {
        const res = await listPersons(client, input);
        if (scope) {
          (res as { _data?: unknown[] })._data = await scope.filter(rows(res), r => String(r.id ?? ''));
        }
        return jsonResult(res);
      }),
  );

  register(
    'personio_get_person',
    {
      title: 'Get Person (Personio, HR)',
      description: 'One person’s profile, optionally with employments.',
      inputSchema: {
        personId: z.string().trim().min(1),
        includeEmployments: z.boolean().default(true),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_get_person', options, input, async () => {
        if (scope) await scope.assert(input.personId, 'personio_get_person');
        return jsonResult(await getPerson(client, input));
      }),
  );

  register(
    'personio_update_person',
    {
      title: 'Update Person (Personio, HR)',
      description:
        'Update master data incl. custom_attributes [{id, value}]. Email cannot be changed via the API; there is deliberately no delete tool. Requires write access.',
      inputSchema: {
        personId: z.string().trim().min(1),
        patch: z.record(z.string(), z.unknown()),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_update_person', options, input, async () => {
        if (scope) await scope.assert(input.personId, 'personio_update_person');
        return jsonResult(await updatePerson(client, input));
      }),
  );

  register(
    'personio_list_absences',
    {
      title: 'List Absences (Personio, HR)',
      description:
        'Absence periods across the company, filterable by personId and date range. balanceForEmail returns that person’s balances instead.',
      inputSchema: {
        personId: z.string().trim().optional(),
        startsAfter: dateSchema.optional(),
        endsBefore: dateSchema.optional(),
        balanceForEmail: z.string().trim().email().optional(),
        ...cursorShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_list_absences', options, input, async () => {
        if (input.balanceForEmail) {
          return jsonResult(await getAbsenceBalance(client, input.balanceForEmail));
        }
        if (scope && input.personId) await scope.assert(input.personId, 'personio_list_absences');
        const res = await listAbsences(client, input);
        if (scope && !input.personId) {
          (res as { _data?: unknown[] })._data = await scope.filter(
            rows(res),
            r => String((r.person as { id?: string })?.id ?? ''),
          );
        }
        return jsonResult(res);
      }),
  );

  register(
    'personio_manage_absence',
    {
      title: 'Manage Absence (Personio, HR)',
      description:
        'Create an absence period for any person, or delete one. Always enters the approval workflow; pending requests are approved in the UI. Requires write access.',
      inputSchema: {
        action: z.enum(['create', 'delete']),
        personId: z.string().trim().optional(),
        absenceTypeId: z.string().trim().optional(),
        startDate: dateSchema.optional(),
        startHalf: halfSchema,
        endDate: dateSchema.optional(),
        endHalf: halfSchema,
        comment: z.string().trim().optional(),
        absencePeriodId: z.string().trim().optional().describe('Required for delete.'),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_manage_absence', options, input, async () => {
        if (input.action === 'delete') {
          if (!input.absencePeriodId) {
            throw new Error('absencePeriodId is required for delete.');
          }
          return jsonResult(await deleteAbsence(client, { absencePeriodId: input.absencePeriodId }));
        }
        if (!input.personId || !input.absenceTypeId || !input.startDate) {
          throw new Error('personId, absenceTypeId, and startDate are required for create.');
        }
        if (scope) await scope.assert(input.personId, 'personio_manage_absence');
        return jsonResult(
          await createAbsence(client, {
            personId: input.personId,
            absenceTypeId: input.absenceTypeId,
            startDate: input.startDate,
            startHalf: input.startHalf,
            endDate: input.endDate,
            endHalf: input.endHalf,
            comment: input.comment,
          }),
        );
      }),
  );

  register(
    'personio_list_attendances',
    {
      title: 'List Attendances (Personio, HR)',
      description: 'Attendance periods across the company, filterable by personId and date range.',
      inputSchema: {
        personId: z.string().trim().optional(),
        startsAfter: z.string().trim().optional(),
        endsBefore: z.string().trim().optional(),
        ...cursorShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_list_attendances', options, input, async () => {
        if (scope && input.personId) await scope.assert(input.personId, 'personio_list_attendances');
        const res = await listAttendances(client, input);
        if (scope && !input.personId) {
          (res as { _data?: unknown[] })._data = await scope.filter(
            rows(res),
            r => String((r.person as { id?: string })?.id ?? ''),
          );
        }
        return jsonResult(res);
      }),
  );

  register(
    'personio_manage_attendance',
    {
      title: 'Manage Attendance (Personio, HR)',
      description: 'Create or delete an attendance period for any person. Approval workflow always applies. Requires write access.',
      inputSchema: {
        action: z.enum(['create', 'delete']),
        personId: z.string().trim().optional(),
        type: z.enum(['WORK', 'BREAK']).optional(),
        start: z.string().trim().optional(),
        end: z.string().trim().optional(),
        projectId: z.string().trim().optional(),
        comment: z.string().trim().optional(),
        attendancePeriodId: z.string().trim().optional().describe('Required for delete.'),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_manage_attendance', options, input, async () => {
        if (input.action === 'delete') {
          if (!input.attendancePeriodId) {
            throw new Error('attendancePeriodId is required for delete.');
          }
          return jsonResult(await deleteAttendance(client, { attendancePeriodId: input.attendancePeriodId }));
        }
        if (!input.personId || !input.type || !input.start || !input.end) {
          throw new Error('personId, type, start, and end are required for create.');
        }
        if (scope) await scope.assert(input.personId, 'personio_manage_attendance');
        return jsonResult(
          await createAttendance(client, {
            personId: input.personId,
            type: input.type,
            start: input.start,
            end: input.end,
            projectId: input.projectId,
            comment: input.comment,
          }),
        );
      }),
  );

  register(
    'personio_manage_project',
    {
      title: 'Manage Projects (Personio, HR)',
      description: 'Create/update/delete time-tracking projects and manage members. Requires write access.',
      inputSchema: {
        action: z.enum(['create', 'update', 'delete', 'add-member', 'remove-member']),
        projectId: z.string().trim().optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
        personId: z.string().trim().optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_manage_project', options, input, async () => jsonResult(await manageProject(client, input))),
  );

  register(
    'personio_list_compensations',
    {
      title: 'List Compensation (Personio, HR)',
      description:
        'scope=entries: compensation entries (startDate/endDate required, max 1 month window; filter by personId/legalEntityId). scope=types/jobs/salary-bands: catalogs. READ-ONLY — API-created entries can never be corrected, so creation is not exposed.',
      inputSchema: {
        scope: z.enum(['entries', 'types', 'jobs', 'salary-bands']),
        personId: z.string().trim().optional(),
        legalEntityId: z.string().trim().optional(),
        startDate: dateSchema.optional(),
        endDate: dateSchema.optional(),
        ...cursorShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_list_compensations', options, input, async () => {
        // On a scoped instance, force the legal-entity filter so entries can't span companies.
        const scoped = scope ? { ...input, legalEntityId: scope.entityId } : input;
        return jsonResult(await listCompensations(client, scoped));
      }),
  );

  register(
    'personio_list_documents',
    {
      title: 'List/Download Documents (Personio, HR)',
      description: 'Documents for an employee (ownerId required), incl. e-signature status. documentId+download=true fetches content.',
      inputSchema: {
        ownerId: z.string().trim().min(1),
        categoryId: z.string().trim().optional(),
        documentId: z.string().trim().optional(),
        download: z.boolean().default(false),
        maxBytes: z.number().int().min(1).max(20 * 1024 * 1024).optional(),
        ...cursorShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_list_documents', options, input, async () => {
        if (scope) await scope.assert(input.ownerId, 'personio_list_documents');
        return jsonResult(await listDocuments(client, input));
      }),
  );

  register(
    'personio_upload_document',
    {
      title: 'Upload Document (Personio, HR)',
      description:
        'Upload a document to an employee profile (v1 flow: numeric employeeId + categoryId). E-signature flows cannot be initiated via API. Requires write access.',
      inputSchema: {
        employeeId: z.number().int().positive().describe('The NUMERIC v1 employee id.'),
        categoryId: z.number().int().positive(),
        title: z.string().trim().min(1),
        fileName: z.string().trim().min(1),
        contentBase64: z.string().min(1),
        mimeType: z.string().trim().optional(),
        comment: z.string().trim().optional(),
        date: dateSchema.optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_upload_document', options, input, async () => jsonResult(await uploadDocument(client, input))),
  );

  register(
    'personio_list_org_data',
    {
      title: 'List Org Data (Personio, HR)',
      description: 'Legal entities, departments, teams, cost centers, or workplaces. Read-only.',
      inputSchema: {
        kind: z.enum(['legal-entities', 'departments', 'teams', 'cost-centers', 'workplaces']),
        ...cursorShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_list_org_data', options, input, async () => jsonResult(await listOrgData(client, input))),
  );

  register(
    'personio_get_custom_report',
    {
      title: 'Custom Reports (Personio, HR)',
      description: 'List reports (no reportId), fetch report data (reportId), or list report attributes (listAttributes=true).',
      inputSchema: {
        reportId: z.string().trim().optional(),
        locale: z.string().trim().optional(),
        listAttributes: z.boolean().default(false),
        ...cursorShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_get_custom_report', options, input, async () => jsonResult(await getReport(client, input))),
  );

  register(
    'personio_list_recruiting',
    {
      title: 'Recruiting (Personio, HR)',
      description: 'Read applications (candidateEmail filter), candidates, jobs, or categories. Read-only Beta API.',
      inputSchema: {
        kind: z.enum(['applications', 'candidates', 'jobs', 'categories']),
        id: z.string().trim().optional(),
        candidateEmail: z.string().trim().email().optional(),
        updatedAfter: z.string().trim().optional(),
        ...cursorShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_list_recruiting', options, input, async () => jsonResult(await listRecruiting(client, input))),
  );

  register(
    'personio_list_attributes',
    {
      title: 'List Attribute Whitelist (Personio, HR)',
      description: 'Diagnostic: which employee attributes this API credential can read (non-whitelisted attributes are silently omitted elsewhere).',
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('personio_list_attributes', options, input, async () => jsonResult(await listAttributes(client))),
  );
}

async function run<T>(tool: string, options: RegisterOptions, input: unknown, call: () => Promise<T>): Promise<T> {
  const policy = checkToolPolicy(tool);
  const target = auditTarget(input);
  const actingAs = options.onBehalfOf ?? '(token credential)';

  if (!policy.allowed) {
    await writeAuditEvent({ tool, actingAs, action: 'policy_denied', target, reason: policy.reason });
    throw new Error(policy.reason);
  }

  await writeAuditEvent({ tool, actingAs, action: 'start', target, reason: policy.reason });

  try {
    const result = await call();
    await writeAuditEvent({ tool, actingAs, action: 'finish', target, status: 'ok' });
    return result;
  } catch (error) {
    await writeAuditEvent({
      tool,
      actingAs,
      action: 'error',
      target,
      status: 'error',
      error: formatUnknownError(error),
    });
    throw error;
  }
}

function auditTarget(input: unknown): unknown {
  if (!input || typeof input !== 'object') {
    return input;
  }
  const value = input as Record<string, unknown>;
  return {
    personId: value.personId,
    employeeId: value.employeeId,
    absenceTypeId: value.absenceTypeId,
    absencePeriodId: value.absencePeriodId,
    attendancePeriodId: value.attendancePeriodId,
    projectId: value.projectId,
    documentId: value.documentId,
    ownerId: value.ownerId,
    reportId: value.reportId,
    action: value.action,
    scope: value.scope,
    kind: value.kind,
    type: value.type,
    startDate: value.startDate,
    endDate: value.endDate,
    query: value.query,
    email: value.email,
    balanceForEmail: value.balanceForEmail,
    candidateEmail: value.candidateEmail,
  };
}

function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}
