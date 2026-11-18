// GENERATED from metamodel/types by `npm run gen:metamodel`. Do not edit.

export type TypeName = "Application" | "Assessment" | "BusinessElement" | "BusinessTerm" | "Classification" | "Column" | "ControlRequirement" | "CrossBorderTransfer" | "DataCategory" | "DataDomain" | "DataProduct" | "Dataset" | "DataVisa" | "Delegation" | "DQRule" | "Exception" | "Group" | "Integration" | "LegalHold" | "Person" | "Policy" | "RecordClass" | "Regulation" | "RetentionSchedule" | "Schema" | "Scope" | "ScopeGroup" | "System" | "Table";

export type Category = "Asset" | "Concept" | "ControlRecord" | "GovernanceObject" | "Party";

/** Application (Asset, v1) */
export interface ApplicationAttributes {
  name: string;
  owner: string;
  delegates?: string[];
  criticality?: "low" | "medium" | "high" | "critical";
  status?: "planned" | "live" | "retiring" | "retired";
  hosting_country: string;
  description?: string;
}

/** Assessment (ControlRecord, v1) */
export interface AssessmentAttributes {
  outcome: "datavisa-required" | "datavisa-not-required";
  assessed_on: string;
  review_due?: string;
}

/** BusinessElement (GovernanceObject, v1) */
export interface BusinessElementAttributes {
  name: string;
  definition?: string;
  criticality?: "low" | "medium" | "high" | "critical";
}

/** BusinessTerm (Concept, v1) */
export interface BusinessTermAttributes {
  name: string;
  definition?: string;
  status?: string;
}

/** Classification (Concept, v1) */
export interface ClassificationAttributes {
  code: string;
  name: string;
  scheme: "pii" | "isr" | "business";
  level?: string;
}

/** Column (Asset, v1) */
export interface ColumnAttributes {
  name: string;
  data_type?: string;
  nullable?: boolean;
  description?: string;
  tags?: string[];
  criticality?: "low" | "medium" | "high" | "critical";
  trust_tier?: "unverified" | "bronze" | "silver" | "gold";
  required_tier?: "bronze" | "silver" | "gold";
  trust_shortfall?: boolean;
  proposed_classification?: string[];
  proposed_from?: string[];
  rejected_classification?: string[];
}

/** ControlRequirement (GovernanceObject, v1) */
export interface ControlRequirementAttributes {
  reference_id: string;
  title: string;
  kind: "operating-instruction" | "technical-control-requirement";
  owner?: string;
  confluence_link?: string;
  version: number;
}

/** CrossBorderTransfer (ControlRecord, v1) */
export interface CrossBorderTransferAttributes {
  from_country: string;
  to_country: string;
  data_categories: string[];
  status: "covered" | "missing" | "expired";
  problem?: string;
  uncovered?: string[];
  detail?: string;
}

/** DataCategory (Concept, v1) */
export interface DataCategoryAttributes {
  name: string;
  definition?: string;
}

/** DataDomain (Concept, v1) */
export interface DataDomainAttributes {
  name: string;
  description?: string;
}

/** DataProduct (Asset, v1) */
export interface DataProductAttributes {
  name: string;
  fabric_id?: string;
  owner?: string;
}

/** Dataset (Asset, v1) */
export interface DatasetAttributes {
  name: string;
  description?: string;
  business_context?: string;
}

/** DataVisa (ControlRecord, v1) */
export interface DataVisaAttributes {
  source_country: string;
  target_country: string;
  data_categories: string[];
  valid_from: string;
  valid_to?: string;
  status?: string;
}

/** Delegation (GovernanceObject, v1) */
export interface DelegationAttributes {
  owner: string;
  delegate: string;
  covers: "one-scope" | "all-scopes";
  valid_from: string;
  valid_to: string;
  reason?: string;
  reminded_on?: string;
  ended_reason?: "revoked" | "owner-changed";
}

/** DQRule (ControlRecord, v1) */
export interface DQRuleAttributes {
  name: string;
  dimension?: string;
  business_context?: string;
  criticality?: "low" | "medium" | "high" | "critical";
}

/** Exception (GovernanceObject, v1) */
export interface ExceptionAttributes {
  kind: string;
  severity?: "low" | "medium" | "high" | "critical";
  status: string;
  due?: string;
  assignee?: string;
}

/** Group (Party, v1) */
export interface GroupAttributes {
  name: string;
  idp_group?: string;
}

/** Integration (Asset, v1) */
export interface IntegrationAttributes {
  mechanism?: string;
  frequency?: string;
  status?: string;
}

/** LegalHold (ControlRecord, v1) */
export interface LegalHoldAttributes {
  reason?: string;
  start: string;
  end?: string;
}

/** Person (Party, v2) */
export interface PersonAttributes {
  email: string;
  staff_id?: string;
  name?: string;
  department?: string;
}

/** Policy (GovernanceObject, v1) */
export interface PolicyAttributes {
  control_type: string;
  mode: "shadow" | "enforced";
  version: number;
  state: string;
}

/** RecordClass (Concept, v1) */
export interface RecordClassAttributes {
  code: string;
  name: string;
  description?: string;
}

/** Regulation (Concept, v1) */
export interface RegulationAttributes {
  code: string;
  name: string;
}

/** RetentionSchedule (ControlRecord, v1) */
export interface RetentionScheduleAttributes {
  period: string;
  trigger_event?: string;
  disposal_action?: string;
}

/** Schema (Asset, v1) */
export interface SchemaAttributes {
  name: string;
}

/** Scope (GovernanceObject, v1) */
export interface ScopeAttributes {
  name: string;
  owner?: string;
  kind: "regulatory-return" | "report" | "report-metric" | "business-process";
  regulation?: string;
  required_tier?: "bronze" | "silver" | "gold";
  criticality?: "low" | "medium" | "high" | "critical";
  version?: number;
  status?: "draft" | "submitted" | "amended";
  locked_at?: string;
}

/** ScopeGroup (GovernanceObject, v1) */
export interface ScopeGroupAttributes {
  name: string;
  order?: number;
}

/** System (Asset, v1) */
export interface SystemAttributes {
  name: string;
  platform?: string;
  environment?: string;
  hosting_country?: string;
}

/** Table (Asset, v1) */
export interface TableAttributes {
  name: string;
  kind?: "table" | "view" | "file";
  description?: string;
  tags?: string[];
  trust_tier?: "unverified" | "bronze" | "silver" | "gold";
  required_tier?: "bronze" | "silver" | "gold";
  trust_shortfall?: boolean;
}

export interface AttributesByType {
  Application: ApplicationAttributes;
  Assessment: AssessmentAttributes;
  BusinessElement: BusinessElementAttributes;
  BusinessTerm: BusinessTermAttributes;
  Classification: ClassificationAttributes;
  Column: ColumnAttributes;
  ControlRequirement: ControlRequirementAttributes;
  CrossBorderTransfer: CrossBorderTransferAttributes;
  DataCategory: DataCategoryAttributes;
  DataDomain: DataDomainAttributes;
  DataProduct: DataProductAttributes;
  Dataset: DatasetAttributes;
  DataVisa: DataVisaAttributes;
  Delegation: DelegationAttributes;
  DQRule: DQRuleAttributes;
  Exception: ExceptionAttributes;
  Group: GroupAttributes;
  Integration: IntegrationAttributes;
  LegalHold: LegalHoldAttributes;
  Person: PersonAttributes;
  Policy: PolicyAttributes;
  RecordClass: RecordClassAttributes;
  Regulation: RegulationAttributes;
  RetentionSchedule: RetentionScheduleAttributes;
  Schema: SchemaAttributes;
  Scope: ScopeAttributes;
  ScopeGroup: ScopeGroupAttributes;
  System: SystemAttributes;
  Table: TableAttributes;
}

export const TYPE_CATEGORY: Record<TypeName, Category> = {
  Application: "Asset",
  Assessment: "ControlRecord",
  BusinessElement: "GovernanceObject",
  BusinessTerm: "Concept",
  Classification: "Concept",
  Column: "Asset",
  ControlRequirement: "GovernanceObject",
  CrossBorderTransfer: "ControlRecord",
  DataCategory: "Concept",
  DataDomain: "Concept",
  DataProduct: "Asset",
  Dataset: "Asset",
  DataVisa: "ControlRecord",
  Delegation: "GovernanceObject",
  DQRule: "ControlRecord",
  Exception: "GovernanceObject",
  Group: "Party",
  Integration: "Asset",
  LegalHold: "ControlRecord",
  Person: "Party",
  Policy: "GovernanceObject",
  RecordClass: "Concept",
  Regulation: "Concept",
  RetentionSchedule: "ControlRecord",
  Schema: "Asset",
  Scope: "GovernanceObject",
  ScopeGroup: "GovernanceObject",
  System: "Asset",
  Table: "Asset",
};
