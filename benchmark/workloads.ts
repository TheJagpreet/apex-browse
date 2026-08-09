export type WorkloadId = 'profile' | 'profile-drift' | 'dialog' | 'renamed-control' | 'catalog';

export type Workload = {
  id: WorkloadId;
  path: string;
  task: string;
  expected: Record<string, unknown>;
};

export const workloads: Workload[] = [
  {
    id: 'profile',
    path: '/profile',
    task: 'Open {{url}}. Fill First name with Ada, Last name with Lovelace, Email with ada@example.test, select Administrator as Role, accept Terms and conditions, save the profile, and verify Profile saved.',
    expected: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', role: 'admin', terms: true },
  },
  {
    id: 'profile-drift',
    path: '/profile-drift',
    task: 'Open {{url}}. Fill First name with Ada, Last name with Lovelace, Email with ada@example.test, select Administrator as Role, accept Terms and conditions, save the profile, and verify Profile saved.',
    expected: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', role: 'admin', terms: true },
  },
  {
    id: 'dialog',
    path: '/dialog',
    task: 'Open {{url}}. Open team settings. In the dialog set Team name to Platform, select India Standard Time as Time zone, enable Email notifications, save changes, and verify Team settings saved.',
    expected: { teamName: 'Platform', timeZone: 'ist', notifications: true },
  },
  {
    id: 'renamed-control',
    path: '/renamed-control',
    task: 'Open {{url}}. Enter Hello in Message, click the intended Send control, and verify Message sent. The visible control label may have minor wording drift from the instruction.',
    expected: { message: 'Hello', activation: 'button-click' },
  },
  {
    id: 'catalog',
    path: '/catalog',
    task: 'Open {{url}}. Search the catalog for Samsung S25 Ultra, open the Galaxy S25 Ultra result, and verify Product details.',
    expected: { query: 'Samsung S25 Ultra', product: 'Galaxy S25 Ultra' },
  },
];

export function workloadById(id: string): Workload {
  const workload = workloads.find(candidate => candidate.id === id);
  if (!workload) throw new Error(`Unknown workload: ${id}`);
  return workload;
}
