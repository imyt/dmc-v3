import type { AssigneeResolver } from './engine.js';

/**
 * Who a task goes to: `route` means the route the instance was started with, `ctx:<key>` means the value of that context key,
 * and any other name is taken as the assignee as written (a person or an IdP group, for example the `escalate_to` of a step). The inbox matches these against the caller's id and groups.
 */
export const routeResolver: AssigneeResolver = {
  resolve: async (rule, { context }) => {
    if (rule === 'route') return String(context.route);
    if (rule.startsWith('ctx:')) {
      const v = context[rule.slice(4)];
      if (v === undefined || v === null || v === '') throw new Error(`The workflow context has no "${rule.slice(4)}" to assign to`);
      return String(v);
    }
    return rule;
  },
};
