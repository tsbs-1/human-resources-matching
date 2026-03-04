const hubspot = require("@hubspot/api-client");

const PRIMARY_JOB_OBJECT_TYPE_ID = "2-32777837";
const DEAL_OBJECT_TYPE_ID = "0-3";
const DEAL_PIPELINE_ID = "17914384";
const INITIAL_DEAL_STAGE_ID = "45226048";

const JOB_PROPERTIES = [
  "job_id",
  "job_name",
  "location",
  "naiyou",
  "saiyou",
  "salary",
  "skill",
  "syokusyu",
];
let cachedJobObjectTypeId = null;

const toStringOrEmpty = (value) => {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
};

const parseErrorMessage = (error) => {
  if (error?.response?.body?.message) {
    return error.response.body.message;
  }
  if (error?.response?.body?.category) {
    return `${error.response.body.category}: ${error.response.body.message || "unknown error"}`;
  }
  if (error?.message) {
    return error.message;
  }
  return "unknown error";
};

const getHubSpotClient = () =>
  new hubspot.Client({
    accessToken: process.env["PRIVATE_APP_ACCESS_TOKEN"],
  });

const hasJobProperties = (schema) => {
  const properties = Array.isArray(schema?.properties) ? schema.properties : [];
  const names = new Set(properties.map((property) => property?.name));
  return (
    names.has("job_id") &&
    names.has("job_name") &&
    names.has("location")
  );
};

const extractResultsAndPaging = (apiResponse) => {
  const body = apiResponse?.body || apiResponse || {};
  const results = Array.isArray(body.results) ? body.results : [];
  const nextAfter = body?.paging?.next?.after || null;
  return { results, nextAfter };
};

const detectJobObjectTypeId = async (client) => {
  if (cachedJobObjectTypeId) {
    return cachedJobObjectTypeId;
  }

  try {
    const preferred = await client.apiRequest({
      method: "GET",
      path: `/crm/v3/schemas/${PRIMARY_JOB_OBJECT_TYPE_ID}`,
    });
    if (preferred?.body?.objectTypeId && hasJobProperties(preferred.body)) {
      cachedJobObjectTypeId = preferred.body.objectTypeId;
      return cachedJobObjectTypeId;
    }
  } catch (error) {
    // Ignore and fall back to configured objectTypeId.
  }

  // 要件で確定している objectTypeId を最優先で使用する。
  cachedJobObjectTypeId = PRIMARY_JOB_OBJECT_TYPE_ID;
  return cachedJobObjectTypeId;
};

const searchJobs = async (client, parameters = {}) => {
  const jobObjectTypeId = await detectJobObjectTypeId(client);
  const { filters = {}, after = null, pageSize = 50 } = parameters;
  const queryText = toStringOrEmpty(parameters.query);
  const location = toStringOrEmpty(filters.location);
  const syokusyu = toStringOrEmpty(filters.syokusyu);
  const skills = Array.isArray(filters.skills)
    ? filters.skills.map(toStringOrEmpty).filter(Boolean)
    : [];
  const limit = Math.min(Number(pageSize) || 50, 50);

  const commonFilters = [];
  if (location) {
    commonFilters.push({
      propertyName: "location",
      operator: "EQ",
      value: location,
    });
  }
  if (syokusyu) {
    commonFilters.push({
      propertyName: "syokusyu",
      operator: "EQ",
      value: syokusyu,
    });
  }

  let filterGroups = [];
  if (skills.length > 0) {
    filterGroups = skills.map((skill) => ({
      filters: [
        ...commonFilters,
        {
          propertyName: "skill",
          operator: "CONTAINS_TOKEN",
          value: skill,
        },
      ],
    }));
  } else if (commonFilters.length > 0) {
    filterGroups = [{ filters: commonFilters }];
  }

  let results = [];
  let nextAfter = null;

  if (queryText) {
    const searchResponse = await client.apiRequest({
      method: "POST",
      path: `/crm/v3/objects/${jobObjectTypeId}/search`,
      body: {
        limit,
        properties: JOB_PROPERTIES,
        after: after || undefined,
        query: queryText,
      },
    });
    const parsed = extractResultsAndPaging(searchResponse);
    results = parsed.results;
    nextAfter = parsed.nextAfter;
  }

  // フィルタ未指定時は一覧APIで全件取得（searchで0件になる環境差分を回避）
  if (results.length === 0 && !queryText && filterGroups.length === 0) {
    const query = new URLSearchParams();
    query.set("limit", String(limit));
    if (after) {
      query.set("after", String(after));
    }
    JOB_PROPERTIES.forEach((property) => query.append("properties", property));
    const pageResponse = await client.apiRequest({
      method: "GET",
      path: `/crm/v3/objects/${jobObjectTypeId}?${query.toString()}`,
    });
    const parsed = extractResultsAndPaging(pageResponse);
    results = parsed.results;
    nextAfter = parsed.nextAfter;
  } else if (!queryText) {
    const body = {
      limit,
      properties: JOB_PROPERTIES,
      after: after || undefined,
      filterGroups,
    };

    const searchResponse = await client.apiRequest({
      method: "POST",
      path: `/crm/v3/objects/${jobObjectTypeId}/search`,
      body,
    });
    const parsed = extractResultsAndPaging(searchResponse);
    results = parsed.results;
    nextAfter = parsed.nextAfter;
  }

  return {
    jobs: results.map((record) => ({
      id: record.id,
      properties: record.properties || {},
    })),
    paging: {
      nextAfter,
    },
    objectTypeId: jobObjectTypeId,
  };
};

const getPropertyOptions = async (client, propertyName) => {
  const jobObjectTypeId = await detectJobObjectTypeId(client);
  const response = await client.apiRequest({
    method: "GET",
    path: `/crm/v3/properties/${jobObjectTypeId}/${propertyName}`,
  });

  return (response.body.options || [])
    .map((option) => toStringOrEmpty(option.value))
    .filter(Boolean);
};

const getPropertyOptionsWithLabel = async (client, propertyName) => {
  const jobObjectTypeId = await detectJobObjectTypeId(client);
  const response = await client.apiRequest({
    method: "GET",
    path: `/crm/v3/properties/${jobObjectTypeId}/${propertyName}`,
  });

  return (response.body.options || [])
    .map((option) => ({
      label: toStringOrEmpty(option.label) || toStringOrEmpty(option.value),
      value: toStringOrEmpty(option.value),
    }))
    .filter((option) => option.value);
};

const deriveUniqueValuesFromRecords = async (client, propertyName, splitValues) => {
  const jobObjectTypeId = await detectJobObjectTypeId(client);
  const response = await client.apiRequest({
    method: "POST",
    path: `/crm/v3/objects/${jobObjectTypeId}/search`,
    body: {
      limit: 200,
      properties: [propertyName],
    },
  });

  const values = new Set();
  const list = Array.isArray(response?.body?.results) ? response.body.results : [];
  for (const record of list) {
    const rawValue = toStringOrEmpty(record.properties?.[propertyName]);
    if (!rawValue) {
      continue;
    }
    if (!splitValues) {
      values.add(rawValue);
      continue;
    }
    rawValue
      .split(/[;,、]/)
      .map((v) => toStringOrEmpty(v))
      .filter(Boolean)
      .forEach((v) => values.add(v));
  }
  return [...values];
};

const getFilterOptions = async (client) => {
  let skillOptions = [];
  let syokusyuOptions = [];

  try {
    skillOptions = await getPropertyOptions(client, "skill");
  } catch (error) {
    skillOptions = [];
  }

  try {
    syokusyuOptions = await getPropertyOptions(client, "syokusyu");
  } catch (error) {
    syokusyuOptions = [];
  }

  if (skillOptions.length === 0) {
    skillOptions = await deriveUniqueValuesFromRecords(client, "skill", true);
  }
  if (syokusyuOptions.length === 0) {
    syokusyuOptions = await deriveUniqueValuesFromRecords(client, "syokusyu", false);
  }

  return {
    skillOptions: skillOptions.sort((a, b) => a.localeCompare(b, "ja")),
    syokusyuOptions: syokusyuOptions.sort((a, b) => a.localeCompare(b, "ja")),
  };
};

const getLocationOptions = async (client) => {
  try {
    const options = await getPropertyOptionsWithLabel(client, "location");
    return {
      locationOptions: options.sort((a, b) => a.label.localeCompare(b.label, "ja")),
    };
  } catch (error) {
    return {
      locationOptions: [],
    };
  }
};

const getAssociationTypeId = async (client, fromObjectType, toObjectType) => {
  const response = await client.apiRequest({
    method: "GET",
    path: `/crm/v3/associations/${fromObjectType}/${toObjectType}/types`,
  });

  const candidates = response.body.results || [];
  if (candidates.length === 0) {
    throw new Error(`Association type not found: ${fromObjectType} -> ${toObjectType}`);
  }

  const preferred = candidates.find((type) =>
    toStringOrEmpty(type.name).startsWith(`${fromObjectType}_to_`)
  );
  const selected = preferred || candidates[0];
  return Number(selected.id);
};

const createDealsAndAssociations = async (client, context, parameters = {}) => {
  const jobObjectTypeId = await detectJobObjectTypeId(client);
  const contactId =
    toStringOrEmpty(parameters.contactId) ||
    toStringOrEmpty(context?.propertiesToSend?.hs_object_id);
  if (!contactId) {
    throw new Error("contactId is required");
  }

  const selectedJobs = Array.isArray(parameters.selectedJobs)
    ? parameters.selectedJobs
    : [];
  if (selectedJobs.length === 0) {
    return {
      successCount: 0,
      failureCount: 0,
      failures: [],
    };
  }

  const firstName = toStringOrEmpty(context?.propertiesToSend?.firstname);
  const lastName = toStringOrEmpty(context?.propertiesToSend?.lastname);
  const ownerId = toStringOrEmpty(context?.propertiesToSend?.hubspot_owner_id);
  const candidateName = `${lastName}${firstName}` || "求職者";

  const dealToContactTypeId = await getAssociationTypeId(client, "deals", "contacts");
  const dealToJobTypeId = await getAssociationTypeId(client, "deals", jobObjectTypeId);

  let successCount = 0;
  const failures = [];

  for (const selectedJob of selectedJobs) {
    const jobId = toStringOrEmpty(selectedJob.id);
    const jobName = toStringOrEmpty(selectedJob.job_name) || `求人${jobId}`;
    if (!jobId) {
      failures.push({ jobId: "unknown", reason: "求人IDが空です" });
      continue;
    }

    const properties = {
      pipeline: DEAL_PIPELINE_ID,
      dealstage: INITIAL_DEAL_STAGE_ID,
      dealname: `${candidateName} × ${jobName}`,
    };
    if (ownerId) {
      properties.hubspot_owner_id = ownerId;
    }

    try {
      await client.apiRequest({
        method: "POST",
        path: `/crm/v3/objects/${DEAL_OBJECT_TYPE_ID}`,
        body: {
          properties,
          associations: [
            {
              to: { id: contactId },
              types: [
                {
                  associationCategory: "HUBSPOT_DEFINED",
                  associationTypeId: dealToContactTypeId,
                },
              ],
            },
            {
              to: { id: jobId },
              types: [
                {
                  associationCategory: "HUBSPOT_DEFINED",
                  associationTypeId: dealToJobTypeId,
                },
              ],
            },
          ],
        },
      });
      successCount += 1;
    } catch (error) {
      failures.push({
        jobId,
        reason: parseErrorMessage(error),
      });
    }
  }

  return {
    successCount,
    failureCount: failures.length,
    failures,
  };
};

exports.main = async (context = {}) => {
  const client = getHubSpotClient();
  const action = context?.parameters?.action;

  try {
    if (action === "getFilterOptions") {
      return await getFilterOptions(client);
    }
    if (action === "searchJobs") {
      return await searchJobs(client, context.parameters);
    }
    if (action === "getLocationOptions") {
      return await getLocationOptions(client);
    }
    if (action === "createDealsAndAssociations") {
      return await createDealsAndAssociations(client, context, context.parameters);
    }

    return {
      status: "error",
      message: `Unsupported action: ${action || "undefined"}`,
    };
  } catch (error) {
    throw new Error(parseErrorMessage(error));
  }
};
