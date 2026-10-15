// slop.delegation_wrapper — every function here only forwards its own
// parameters, unchanged and in order, and returns the result.
import { fetchUser as loadUser, formatDate } from './api.js';
import * as api from './api.js';

export function getUser(id: string): Promise<unknown> {
  return loadUser(id);
}

const parseConfig = (text: string) => JSON.parse(text);

const formatAll = (...parts: string[]) => {
  return api.join(...parts);
};

class ReportView {
  stamp(date: Date): string {
    return formatDate(date);
  }
}

console.info(getUser('1'), parseConfig('{}'), formatAll('a'), new ReportView().stamp(new Date()));
