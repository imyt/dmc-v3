// Captured from a local API run (GET /v1/policies and GET /v1/policies/{id}) against the six seeded policies in policies/examples.
import type { ApiPolicyDetail, ApiPolicySummary } from '@/lib/data';

export const seededPolicies: ApiPolicySummary[] = [
  {
    "id": "application-has-owner",
    "control": "ownership",
    "type": "Application",
    "mode": "enforced",
    "source_mode": "enforced",
    "paused": false,
    "effective": true
  },
  {
    "id": "classification-proposed",
    "control": "classification",
    "type": "Column",
    "implements": "TCR-0005",
    "mode": "shadow",
    "source_mode": "shadow",
    "paused": false,
    "effective": true
  },
  {
    "id": "critical-app-review",
    "control": "criticality",
    "type": "Application",
    "mode": "shadow",
    "source_mode": "shadow",
    "paused": false,
    "effective": true
  },
  {
    "id": "cross-border-covered",
    "control": "privacy",
    "type": "CrossBorderTransfer",
    "implements": "TCR-0004",
    "mode": "shadow",
    "source_mode": "shadow",
    "paused": false,
    "effective": true
  },
  {
    "id": "integration-has-dataset",
    "control": "data-movement",
    "type": "Integration",
    "implements": "TCR-0001",
    "mode": "shadow",
    "source_mode": "shadow",
    "paused": false,
    "effective": true
  },
  {
    "id": "required-trust-tier",
    "control": "trust",
    "type": "Column",
    "implements": "TCR-0003",
    "mode": "shadow",
    "source_mode": "shadow",
    "paused": false,
    "effective": true
  }
];

export const seededPolicyDetails: Record<string, ApiPolicyDetail> = {
  "application-has-owner": {
    "id": "application-has-owner",
    "control": "ownership",
    "type": "Application",
    "mode": "enforced",
    "source_mode": "enforced",
    "paused": false,
    "effective": true,
    "path": "policies/examples/application-has-owner.yaml",
    "yaml": "policy: application-has-owner\ncontrol: ownership\nmode: enforced\nscope:\n  type: Application\nwhen: \"!has(application.owner) || application.owner == ''\"\neffect:\n  action: raise_exception\n  message: Every application needs an owner\nroute: platform-governance\nescalate_after: 5d\nautonomy: act_notify\n",
    "golden": "cases:\n  - name: missing owner matches\n    asset: { qualified_name: servicenow.APP1, name: Payments }\n    expect: true\n  - name: empty owner matches\n    asset: { qualified_name: servicenow.APP2, owner: '' }\n    expect: true\n  - name: owner present does not match\n    asset: { qualified_name: servicenow.APP3, owner: alice@example.com }\n    expect: false\n",
    "checksum": "a8498c3d2b1360f246c97353df590ab0dbdc709b4f246a2e88a770ce8e9f3c60"
  },
  "classification-proposed": {
    "id": "classification-proposed",
    "control": "classification",
    "type": "Column",
    "implements": "TCR-0005",
    "mode": "shadow",
    "source_mode": "shadow",
    "paused": false,
    "effective": true,
    "path": "policies/examples/classification-proposed.yaml",
    "yaml": "policy: classification-proposed\ncontrol: classification\nimplements: TCR-0005\nmode: shadow\nscope:\n  type: Column\nwhen: size(column.proposed_classification) > 0\neffect:\n  action: raise_exception\n  message: A classification is proposed for this column from the columns it is built from; confirm or reject it\nroute: data-steward\nescalate_after: 14d\n",
    "golden": "cases:\n  - name: a proposal matches\n    asset: { qualified_name: a.s.t.c, proposed_classification: ['pii:email'] }\n    expect: true\n  - name: no proposal does not\n    asset: { qualified_name: a.s.t.c, proposed_classification: [] }\n    expect: false\n",
    "checksum": "19096c719896e39018760aae30b816ad69eb183156f65f1fcc2530fb7345c508"
  },
  "critical-app-review": {
    "id": "critical-app-review",
    "control": "criticality",
    "type": "Application",
    "mode": "shadow",
    "source_mode": "shadow",
    "paused": false,
    "effective": true,
    "path": "policies/examples/critical-app-review.yaml",
    "yaml": "policy: critical-app-review\ncontrol: criticality\nmode: shadow\nscope:\n  type: Application\nwhen: application.criticality == 'critical' && application.status != 'retired'\neffect:\n  action: create_task\n  message: Confirm the criticality of this application\nroute: application-owner\nescalate_after: 30d\n",
    "golden": "cases:\n  - name: live critical app matches\n    asset: { criticality: critical, status: live }\n    expect: true\n  - name: retired app does not match\n    asset: { criticality: critical, status: retired }\n    expect: false\n  - name: low criticality does not match\n    asset: { criticality: low, status: live }\n    expect: false\n",
    "checksum": "7b74d6d3fe006ed430cc7167fb650ad69e978bc96464c3eee647dc1d85d9458b"
  },
  "cross-border-covered": {
    "id": "cross-border-covered",
    "control": "privacy",
    "type": "CrossBorderTransfer",
    "implements": "TCR-0004",
    "mode": "shadow",
    "source_mode": "shadow",
    "paused": false,
    "effective": true,
    "path": "policies/examples/cross-border-covered.yaml",
    "yaml": "policy: cross-border-covered\ncontrol: privacy\nimplements: TCR-0004\nmode: shadow\nscope:\n  type: CrossBorderTransfer\nwhen: cross_border_transfer.status != 'covered'\neffect:\n  action: raise_exception\n  message: This cross-border transfer has no assessment, or its DataVisa is missing or expired; see the transfer for which\nroute: data-owner\nescalate_after: 10d\n",
    "golden": "cases:\n  - name: missing cover matches\n    asset: { qualified_name: int-1--gb-us, status: missing }\n    expect: true\n  - name: expired cover matches\n    asset: { qualified_name: int-1--gb-us, status: expired }\n    expect: true\n  - name: covered does not\n    asset: { qualified_name: int-1--gb-us, status: covered }\n    expect: false\n",
    "checksum": "1b73a63735a63f2c2e45b30b5c1c26ad43efa8a93e3cb3e4634b130ea5335698"
  },
  "integration-has-dataset": {
    "id": "integration-has-dataset",
    "control": "data-movement",
    "type": "Integration",
    "implements": "TCR-0001",
    "mode": "shadow",
    "source_mode": "shadow",
    "paused": false,
    "effective": true,
    "path": "policies/examples/integration-has-dataset.yaml",
    "yaml": "policy: integration-has-dataset\ncontrol: data-movement\nimplements: TCR-0001\nmode: shadow\nscope:\n  type: Integration\nwhen: size(integration.transfers) == 0\neffect:\n  action: raise_exception\n  message: Link at least one dataset to this integration\nroute: application-owner\nescalate_after: 10d\n",
    "golden": "cases:\n  - name: integration with no dataset matches\n    asset: { qualified_name: servicenow.INT001, transfers: [] }\n    expect: true\n  - name: integration with a dataset does not match\n    asset: { qualified_name: servicenow.INT002, transfers: [{ qualified_name: ds.payments }] }\n    expect: false\n  - name: asset without the edge is an error, not a silent pass\n    asset: { qualified_name: servicenow.INT003 }\n    expect: error\n",
    "checksum": "eaeabaa7e2c7af70a50e6311447dcdfb9c4c7b6022c05506205ba70903c58764"
  },
  "required-trust-tier": {
    "id": "required-trust-tier",
    "control": "trust",
    "type": "Column",
    "implements": "TCR-0003",
    "mode": "shadow",
    "source_mode": "shadow",
    "paused": false,
    "effective": true,
    "path": "policies/examples/required-trust-tier.yaml",
    "yaml": "policy: required-trust-tier\ncontrol: trust\nimplements: TCR-0003\nmode: shadow\nscope:\n  type: Column\nwhen: column.trust_shortfall == true\neffect:\n  action: raise_exception\n  message: This asset is below the trust tier its scopes require; see its grades for what is holding it down\nroute: data-owner\nescalate_after: 30d\n",
    "golden": "cases:\n  - name: below the required tier matches\n    asset: { qualified_name: a.s.t.c, trust_shortfall: true }\n    expect: true\n  - name: at the required tier does not\n    asset: { qualified_name: a.s.t.c, trust_shortfall: false }\n    expect: false\n",
    "checksum": "b6602df7523a2b0a8ffb27fe84abc1f49dc8260b519eac410580a9cdec1ad6f4"
  }
};
