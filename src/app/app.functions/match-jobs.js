const hubspot = require("@hubspot/api-client");
const axios = require("axios");

// 求人カスタムオブジェクト（URL例: …/contacts/22314624/objects/2-32777837/…）
// ポータルID: 22314624 / オブジェクトID: 2-32777837
const PRIMARY_JOB_OBJECT_TYPE_ID = "2-32777837";
const HUBSPOT_API_BASE = "https://api.hubapi.com";
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
let cachedDetectionSource = "fallback-primary";
let cachedDetectionReason = "not-evaluated";
let cachedDetectionTotal = 0;

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
  if (error?.response?.data?.message) {
    return error.response.data.message;
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
  // サーバーレス環境で body/data/直接のいずれで返るかに対応
  const raw =
    apiResponse?.body ??
    apiResponse?.data ??
    (Array.isArray(apiResponse?.results) ? apiResponse : null) ??
    apiResponse ??
    {};
  const body = typeof raw === "object" && raw !== null ? raw : {};
  const results = Array.isArray(body.results) ? body.results : [];
  const nextAfter = body?.paging?.next?.after ?? null;
  return { results, nextAfter };
};

// deal-contact-selector と同様に axios で直接 API を叩く（response.data で一意にパース可能）
const fetchJobListWithAxios = async (objectTypeId, limit, after) => {
  const token = process.env["PRIVATE_APP_ACCESS_TOKEN"];
  if (!token) return { results: [], nextAfter: null };
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (after) params.set("after", String(after));
  JOB_PROPERTIES.forEach((p) => params.append("properties", p));
  const url = `${HUBSPOT_API_BASE}/crm/v3/objects/${objectTypeId}?${params.toString()}`;
  const res = await axios.get(url, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  const data = res.data || {};
  return {
    results: Array.isArray(data.results) ? data.results : [],
    nextAfter: data?.paging?.next?.after ?? null,
  };
};

// 関連付けタイプ取得も axios で確実に response.data.results を取得
const fetchAssociationTypesWithAxios = async (fromObjectType, toObjectType) => {
  const token = process.env["PRIVATE_APP_ACCESS_TOKEN"];
  if (!token) return [];
  const url = `${HUBSPOT_API_BASE}/crm/v3/associations/${encodeURIComponent(fromObjectType)}/${encodeURIComponent(toObjectType)}/types`;
  const res = await axios.get(url, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  const data = res.data || {};
  return Array.isArray(data.results) ? data.results : [];
};

// v4 API で関連付け（deal-contact-selector と同様。Deal 作成時の inline associations は保存されない場合があるため別呼び出し）
const putAssociationV4 = async (fromObjectType, fromId, toObjectType, toId) => {
  const token = process.env["PRIVATE_APP_ACCESS_TOKEN"];
  if (!token) throw new Error("PRIVATE_APP_ACCESS_TOKEN is required");
  const url = `${HUBSPOT_API_BASE}/crm/v4/objects/${fromObjectType}/${fromId}/associations/default/${toObjectType}/${toId}`;
  await axios.put(url, null, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
};

const fetchFirstRecord = async (client, objectTypeId) => {
  const query = new URLSearchParams();
  query.set("limit", "1");
  // 検出用途ではプロパティを指定しない（候補オブジェクトごとのプロパティ差分で400になるのを回避）
  const response = await client.apiRequest({
    method: "GET",
    path: `/crm/v3/objects/${objectTypeId}?${query.toString()}`,
  });
  return extractResultsAndPaging(response).results;
};

const fetchObjectTotal = async (client, objectTypeId) => {
  try {
    const response = await client.apiRequest({
      method: "POST",
      path: `/crm/v3/objects/${objectTypeId}/search`,
      body: { limit: 1 },
    });
    const raw = response?.body ?? response?.data ?? response ?? {};
    const body = typeof raw === "object" && raw !== null ? raw : {};
    const total = Number(body.total);
    if (Number.isFinite(total)) {
      return total;
    }
    const results = Array.isArray(body.results) ? body.results : [];
    return results.length;
  } catch (error) {
    return 0;
  }
};

const scoreSchemaCandidate = (schema) => {
  const objectTypeId = schema?.objectTypeId || "";
  const names = [schema?.name, schema?.labels?.singular, schema?.labels?.plural]
    .map((value) => toStringOrEmpty(value).toLowerCase())
    .join(" ");
  let score = 0;
  if (objectTypeId === PRIMARY_JOB_OBJECT_TYPE_ID) {
    score += 100;
  }
  if (hasJobProperties(schema)) {
    score += 50;
  }
  if (names.includes("job") || names.includes("求人")) {
    score += 20;
  }
  return score;
};

const detectJobObjectTypeId = async (client) => {
  try {
    const preferred = await client.apiRequest({
      method: "GET",
      path: `/crm/v3/schemas/${PRIMARY_JOB_OBJECT_TYPE_ID}`,
    });
    const preferredBody = preferred?.body ?? preferred?.data ?? preferred ?? {};
    if (preferredBody?.objectTypeId && hasJobProperties(preferredBody)) {
      try {
        const records = await fetchFirstRecord(client, preferredBody.objectTypeId);
        if (records.length > 0) {
          cachedJobObjectTypeId = preferredBody.objectTypeId;
          cachedDetectionSource = "primary-with-records";
          cachedDetectionReason = "primary-object-has-records";
          cachedDetectionTotal = records.length;
          return cachedJobObjectTypeId;
        }
        cachedDetectionReason = "primary-object-empty";
      } catch (error) {
        // Ignore and continue candidate scan.
        cachedDetectionReason = `primary-probe-failed:${parseErrorMessage(error)}`;
      }
    }
  } catch (error) {
    // Ignore and continue candidate scan.
    cachedDetectionReason = `primary-schema-read-failed:${parseErrorMessage(error)}`;
  }

  try {
    const schemasResponse = await client.apiRequest({
      method: "GET",
      path: "/crm/v3/schemas",
    });
    const schemasBody = schemasResponse?.body ?? schemasResponse?.data ?? schemasResponse ?? {};
    const schemas = Array.isArray(schemasBody?.results) ? schemasBody.results : [];

    const customSchemas = schemas
      .filter((schema) => toStringOrEmpty(schema?.objectTypeId).startsWith("2-"))
      .sort((a, b) => scoreSchemaCandidate(b) - scoreSchemaCandidate(a))
      .slice(0, 40);

    let fallbackCandidate = null;
    for (const schema of customSchemas) {
      const objectTypeId = toStringOrEmpty(schema.objectTypeId);
      if (!objectTypeId) {
        continue;
      }
      const total = await fetchObjectTotal(client, objectTypeId);
      if (total <= 0) {
        continue;
      }

      if (!fallbackCandidate) {
        fallbackCandidate = { objectTypeId, total };
      }

      try {
        const records = await fetchFirstRecord(client, objectTypeId);
        if (!Array.isArray(records) || records.length === 0) {
          continue;
        }
        const firstProps = records[0]?.properties || {};
        const hasJobLikeValues =
          toStringOrEmpty(firstProps.job_name) ||
          toStringOrEmpty(firstProps.job_id) ||
          toStringOrEmpty(firstProps.location);
        if (hasJobLikeValues || objectTypeId === PRIMARY_JOB_OBJECT_TYPE_ID) {
          cachedJobObjectTypeId = objectTypeId;
          cachedDetectionSource = `schema-scan:${objectTypeId}`;
          cachedDetectionReason = "schema-scan-found-records";
          cachedDetectionTotal = total;
          return cachedJobObjectTypeId;
        }
      } catch (error) {
        // Ignore invalid/unauthorized schemas and keep scanning.
      }
    }

    if (fallbackCandidate) {
      cachedJobObjectTypeId = fallbackCandidate.objectTypeId;
      cachedDetectionSource = `schema-scan:${fallbackCandidate.objectTypeId}`;
      cachedDetectionReason = "schema-scan-found-total-only";
      cachedDetectionTotal = fallbackCandidate.total;
      return cachedJobObjectTypeId;
    }
    cachedDetectionReason = "schema-scan-no-records";
  } catch (error) {
    // Ignore and fall back.
    cachedDetectionReason = `schema-scan-failed:${parseErrorMessage(error)}`;
  }

  // 要件で確定している objectTypeId を最優先で使用する。
  cachedJobObjectTypeId = PRIMARY_JOB_OBJECT_TYPE_ID;
  cachedDetectionSource = "fallback-primary";
  cachedDetectionTotal = 0;
  if (!cachedDetectionReason || cachedDetectionReason === "not-evaluated") {
    cachedDetectionReason = "fallback-without-candidates";
  }
  return cachedJobObjectTypeId;
};

const searchJobs = async (client, parameters = {}) => {
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

  // 検索・フィルタなし: 求人オブジェクトを直接指定して一覧取得（detect を経由しない）
  // deal-contact-selector と同様に axios を優先（response.data で確実にパース）
  if (!queryText && filterGroups.length === 0) {
    const jobObjectTypeId = PRIMARY_JOB_OBJECT_TYPE_ID;
    try {
      const axiosResult = await fetchJobListWithAxios(
        jobObjectTypeId,
        limit,
        after || undefined
      );
      results = axiosResult.results;
      nextAfter = axiosResult.nextAfter;
    } catch (e) {
      // axios 失敗時は SDK/apiRequest にフォールバック
    }
    if (results.length === 0) {
      try {
        if (typeof client.crm?.objects?.basicApi?.getPage === "function") {
          const pageResponse = await client.crm.objects.basicApi.getPage(
            jobObjectTypeId,
            limit,
            after || undefined,
            JOB_PROPERTIES
          );
          const parsed = extractResultsAndPaging(pageResponse);
          results = parsed.results;
          nextAfter = parsed.nextAfter;
        }
      } catch (e2) {
        // ignore
      }
    }
    if (results.length === 0) {
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
    }
    return {
      jobs: results.map((record) => ({
        id: record.id,
        properties: record.properties || {},
      })),
      paging: { nextAfter },
      objectTypeId: jobObjectTypeId,
      detectionSource: "direct-list",
      detectionReason: "no-query-no-filters",
      detectionTotal: results.length,
    };
  }

  if (queryText) {
    // サーバーサイド検索が環境差分で不安定なため、
    // axios で一覧を取得して「求人名(job_name)」などをサーバー側でフィルタする
    const jobObjectTypeId = PRIMARY_JOB_OBJECT_TYPE_ID;
    const axiosResult = await fetchJobListWithAxios(
      jobObjectTypeId,
      limit,
      after || undefined
    );
    const keyword = queryText.toLowerCase();
    results = axiosResult.results.filter((record) => {
      const props = record.properties || {};
      const name = toStringOrEmpty(props.job_name).toLowerCase();
      const id = toStringOrEmpty(props.job_id).toLowerCase();
      const locationText = toStringOrEmpty(props.location).toLowerCase();
      return (
        name.includes(keyword) ||
        id.includes(keyword) ||
        locationText.includes(keyword)
      );
    });
    nextAfter = null;

    return {
      jobs: results.map((record) => ({
        id: record.id,
        properties: record.properties || {},
      })),
      paging: {
        nextAfter: null,
      },
      objectTypeId: jobObjectTypeId,
      detectionSource: "client-filter",
      detectionReason: "job_name/job_id/location-contains",
      detectionTotal: axiosResult.results.length,
    };
  } else if (filterGroups.length > 0) {
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
    detectionSource: cachedDetectionSource,
    detectionReason: cachedDetectionReason,
    detectionTotal: cachedDetectionTotal,
  };
};

const getPropertyOptions = async (client, propertyName) => {
  const jobObjectTypeId = await detectJobObjectTypeId(client);
  const response = await client.apiRequest({
    method: "GET",
    path: `/crm/v3/properties/${jobObjectTypeId}/${propertyName}`,
  });

  const raw = response?.body ?? response?.data ?? response ?? {};
  const options = Array.isArray(raw?.options) ? raw.options : [];
  return options
    .map((option) => toStringOrEmpty(option.value))
    .filter(Boolean);
};

const getPropertyOptionsWithLabel = async (client, propertyName) => {
  const jobObjectTypeId = await detectJobObjectTypeId(client);
  const response = await client.apiRequest({
    method: "GET",
    path: `/crm/v3/properties/${jobObjectTypeId}/${propertyName}`,
  });

  const raw = response?.body ?? response?.data ?? response ?? {};
  const options = Array.isArray(raw?.options) ? raw.options : [];
  return options
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
  const raw = response?.body ?? response?.data ?? response ?? {};
  const body = typeof raw === "object" && raw !== null ? raw : {};
  const list = Array.isArray(body.results) ? body.results : [];
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
  let candidates = await fetchAssociationTypesWithAxios(fromObjectType, toObjectType);
  // 名前で取れない場合は object type ID で再試行（deals=0-3, contacts=0-1）
  if (candidates.length === 0 && fromObjectType === "deals" && toObjectType === "contacts") {
    candidates = await fetchAssociationTypesWithAxios("0-3", "0-1");
  }
  // HubSpot 標準の deal-contact は type id 3。API が空を返す場合のフォールバック
  if (candidates.length === 0 && fromObjectType === "deals" && toObjectType === "contacts") {
    return 3;
  }
  if (candidates.length === 0) {
    throw new Error(`Association type not found: ${fromObjectType} -> ${toObjectType}`);
  }
  const selected = candidates[0];
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

  const token = process.env["PRIVATE_APP_ACCESS_TOKEN"];
  if (!token) throw new Error("PRIVATE_APP_ACCESS_TOKEN is required");

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
      // 1) Deal のみ作成（inline associations は保存されないことがあるため使わない）
      const createRes = await axios.post(
        `${HUBSPOT_API_BASE}/crm/v3/objects/${DEAL_OBJECT_TYPE_ID}`,
        { properties },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
        }
      );
      const dealId = createRes.data?.id;
      if (!dealId) {
        failures.push({ jobId, reason: "Deal 作成後の ID が取得できませんでした" });
        continue;
      }

      // 2) v4 で Deal → Contact を関連付け（コンタクトに取引が表示されるようにする）
      await putAssociationV4("deal", String(dealId), "contact", String(contactId));

      // 3) v4 で Deal → 求人 を関連付け
      await putAssociationV4("deal", String(dealId), jobObjectTypeId, String(jobId));

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
  // Re-evaluate detection every invocation to avoid stale warm-container cache.
  cachedJobObjectTypeId = null;
  cachedDetectionSource = "fallback-primary";
  cachedDetectionReason = "not-evaluated";
  cachedDetectionTotal = 0;

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
