import {
  emptyOrganizationPolicy,
  emptyWorkspacePolicy,
  policyView,
} from "../../packages/protocol/model-policy";

/** The model policy of an organization and workspace that saved none. */
export const emptyModelPolicyView = () =>
  policyView(
    {
      organization: { revision: 0, policy: emptyOrganizationPolicy() },
      workspace: { revision: 0, policy: emptyWorkspacePolicy() },
    },
    [],
  );
