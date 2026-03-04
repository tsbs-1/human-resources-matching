import React, { useEffect, useMemo, useState } from "react";
import {
  hubspot,
  Button,
  Checkbox,
  Divider,
  EmptyState,
  Flex,
  LoadingSpinner,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Text,
} from "@hubspot/ui-extensions";

const PAGE_SIZE = 50;
const PREFECTURES = [
  "北海道",
  "青森県",
  "岩手県",
  "宮城県",
  "秋田県",
  "山形県",
  "福島県",
  "茨城県",
  "栃木県",
  "群馬県",
  "埼玉県",
  "千葉県",
  "東京都",
  "神奈川県",
  "新潟県",
  "富山県",
  "石川県",
  "福井県",
  "山梨県",
  "長野県",
  "岐阜県",
  "静岡県",
  "愛知県",
  "三重県",
  "滋賀県",
  "京都府",
  "大阪府",
  "兵庫県",
  "奈良県",
  "和歌山県",
  "鳥取県",
  "島根県",
  "岡山県",
  "広島県",
  "山口県",
  "徳島県",
  "香川県",
  "愛媛県",
  "高知県",
  "福岡県",
  "佐賀県",
  "長崎県",
  "熊本県",
  "大分県",
  "宮崎県",
  "鹿児島県",
  "沖縄県",
];

hubspot.extend(({ actions, context }) => (
  <JobMatchingCard addAlert={actions.addAlert} context={context} />
));

const JobMatchingCard = ({ addAlert, context }) => {
  const [location, setLocation] = useState("");

  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isAssociating, setIsAssociating] = useState(false);
  const [resultSummary, setResultSummary] = useState(null);

  const [pageCursors, setPageCursors] = useState([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [nextCursor, setNextCursor] = useState(null);

  const [selectedJobsById, setSelectedJobsById] = useState({});

  const selectedCount = useMemo(
    () => Object.keys(selectedJobsById).length,
    [selectedJobsById]
  );

  const loadJobs = async ({ targetPageIndex, cursors }) => {
    setLoading(true);
    setResultSummary(null);
    try {
      const after = cursors[targetPageIndex] || null;
      const response = await hubspot.serverless("jobMatching", {
        propertiesToSend: [],
        parameters: {
          action: "searchJobs",
          pageSize: PAGE_SIZE,
          after,
          filters: {
            location: location || null,
          },
        },
      });

      setJobs(response.jobs || []);
      setNextCursor(response.paging?.nextAfter || null);

      const nextCursors = [...cursors];
      if (response.paging?.nextAfter) {
        nextCursors[targetPageIndex + 1] = response.paging.nextAfter;
      }
      setPageCursors(nextCursors);
      setPageIndex(targetPageIndex);
    } catch (error) {
      setJobs([]);
      addAlert({
        title: "求人の取得に失敗しました",
        message: error.message || "APIエラーが発生しました。",
        type: "danger",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let isMounted = true;
    const bootstrap = async () => {
      if (isMounted) {
        await loadJobs({ targetPageIndex: 0, cursors: [null] });
      }
    };
    bootstrap();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    const resetCursors = [null];
    loadJobs({ targetPageIndex: 0, cursors: resetCursors });
  }, [location]);

  const toggleSelection = (job) => {
    setSelectedJobsById((prev) => {
      const next = { ...prev };
      if (next[job.id]) {
        delete next[job.id];
      } else {
        next[job.id] = {
          id: job.id,
          job_name: job.properties.job_name || "",
        };
      }
      return next;
    });
  };

  const clearFilters = () => {
    setLocation("");
  };

  const runAssociation = async () => {
    if (selectedCount === 0 || isAssociating) {
      return;
    }

    setIsAssociating(true);
    setResultSummary(null);
    try {
      const response = await hubspot.serverless("jobMatching", {
        propertiesToSend: ["hs_object_id", "firstname", "lastname", "hubspot_owner_id"],
        parameters: {
          action: "createDealsAndAssociations",
          contactId: String(context.crm.objectId),
          selectedJobs: Object.values(selectedJobsById),
        },
      });

      setResultSummary(response);
      setSelectedJobsById({});

      if (response.failureCount === 0) {
        addAlert({
          title: "関連付けが完了しました",
          message: `${response.successCount}件作成しました`,
          type: "success",
        });
      } else if (response.successCount > 0) {
        addAlert({
          title: "一部成功",
          message: `成功 ${response.successCount} 件 / 失敗 ${response.failureCount} 件`,
          type: "warning",
        });
      } else {
        addAlert({
          title: "関連付けに失敗しました",
          message: "Deal作成/関連付けができませんでした。",
          type: "danger",
        });
      }
    } catch (error) {
      addAlert({
        title: "関連付けに失敗しました",
        message: error.message || "APIエラーが発生しました。",
        type: "danger",
      });
    } finally {
      setIsAssociating(false);
    }
  };

  const goNextPage = async () => {
    if (!nextCursor) {
      return;
    }
    await loadJobs({ targetPageIndex: pageIndex + 1, cursors: pageCursors });
  };

  const goPreviousPage = async () => {
    if (pageIndex === 0) {
      return;
    }
    await loadJobs({ targetPageIndex: pageIndex - 1, cursors: pageCursors });
  };

  return (
    <Flex direction="column" gap="small">
      <Text format={{ fontWeight: "demibold" }}>フィルタ</Text>
      <Flex direction="row" gap="small" wrap={true}>
        <Select
          label="勤務地（都道府県）"
          name="location"
          value={location}
          onChange={(value) => setLocation(value || "")}
          options={[
            { label: "全件", value: "" },
            ...PREFECTURES.map((pref) => ({ label: pref, value: pref })),
          ]}
        />
      </Flex>
      <Button variant="secondary" onClick={clearFilters}>
        クリア
      </Button>

      <Divider />

      <Text format={{ fontWeight: "demibold" }}>求人一覧</Text>
      {loading ? (
        <Flex direction="row" gap="small" align="center">
          <LoadingSpinner />
          <Text>求人を検索中...</Text>
        </Flex>
      ) : jobs.length === 0 ? (
        <EmptyState
          title="該当する求人がありません"
          layout="vertical"
          imageWidth={160}
          reverseOrder={false}
        >
          <Text>フィルタ条件を変更して再検索してください。</Text>
        </EmptyState>
      ) : (
        <Table bordered={true}>
          <TableHead>
            <TableRow>
              <TableHeader width="min">選択</TableHeader>
              <TableHeader>求人名</TableHeader>
              <TableHeader>求人ID</TableHeader>
              <TableHeader>勤務地</TableHeader>
              <TableHeader>職種</TableHeader>
              <TableHeader>必要スキル</TableHeader>
              <TableHeader>給与（年収）</TableHeader>
              <TableHeader>採用数</TableHeader>
              <TableHeader>職務内容</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {jobs.map((job) => (
              <TableRow key={job.id}>
                <TableCell width="min">
                  <Checkbox
                    checked={Boolean(selectedJobsById[job.id])}
                    name={`job-${job.id}`}
                    onChange={() => toggleSelection(job)}
                  >
                    選択
                  </Checkbox>
                </TableCell>
                <TableCell>{job.properties.job_name || "-"}</TableCell>
                <TableCell>{job.properties.job_id || "-"}</TableCell>
                <TableCell>{job.properties.location || "-"}</TableCell>
                <TableCell>{job.properties.syokusyu || "-"}</TableCell>
                <TableCell>{job.properties.skill || "-"}</TableCell>
                <TableCell>{job.properties.salary || "-"}</TableCell>
                <TableCell>{job.properties.saiyou || "-"}</TableCell>
                <TableCell>{job.properties.naiyou || "-"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Flex direction="row" gap="small" align="center">
        <Button
          variant="secondary"
          onClick={goPreviousPage}
          disabled={loading || pageIndex === 0}
        >
          前へ
        </Button>
        <Text>{pageIndex + 1} ページ目</Text>
        <Button
          variant="secondary"
          onClick={goNextPage}
          disabled={loading || !nextCursor}
        >
          次へ
        </Button>
      </Flex>

      <Divider />

      <Flex direction="row" gap="small" align="center">
        <Text>選択中: {selectedCount} 件</Text>
        <Button
          variant="primary"
          onClick={runAssociation}
          disabled={selectedCount === 0 || isAssociating}
        >
          {isAssociating ? "関連付け中..." : "関連付ける"}
        </Button>
      </Flex>

      {resultSummary ? (
        <Flex direction="column" gap="extra-small">
          <Text>
            結果: 成功 {resultSummary.successCount} 件 / 失敗{" "}
            {resultSummary.failureCount} 件
          </Text>
          {(resultSummary.failures || []).slice(0, 10).map((failure, index) => (
            <Text key={`${failure.jobId}-${index}`}>
              - 求人ID {failure.jobId}: {failure.reason}
            </Text>
          ))}
        </Flex>
      ) : null}
    </Flex>
  );
};

