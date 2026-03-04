# HubSpot求人×求職者マッチング（MVP）

HubSpot private app (platform `2025.1`) として、以下を実装しています。

- コンタクト詳細の中央タブ（`crm.record.tab`）に「求人一覧」カードを表示
- 求人（custom object `2-32777837`）をフィルタ検索して一覧表示
- 複数選択して「関連付ける」押下で Deal を自動作成
- 作成した Deal を Contact と Job に同時関連付け

## 実装済み固定値

- 求人 objectTypeId: `2-32777837`
- Deal pipelineId: `17914384`
- 初期 stageId: `45226048`（仮マッチング）
- 求人プロパティ:
  - `job_id`, `job_name`, `location`, `naiyou`, `saiyou`, `salary`, `skill`, `syokusyu`

## ファイル構成

- `hsproject.json`
- `src/app/app.json`
- `src/app/extensions/job-matching-card.json`
- `src/app/extensions/JobMatchingCard.jsx`
- `src/app/extensions/package.json`
- `src/app/app.functions/serverless.json`
- `src/app/app.functions/match-jobs.js`
- `src/app/app.functions/package.json`

## ローカル開発手順

1. HubSpot CLI ログイン
2. 依存インストール
   - `hs project install-deps`
3. アップロード
   - `hs project upload`
4. 開発モード
   - `hs project dev`

## HubSpot画面側の設定

1. コンタクトレコードを開く
2. **Customize tabs** から新規タブ（例: 求人一覧）を追加
3. カードタイプ **Apps** から本カード（`求人一覧`）を追加
4. 保存後、レコードを再読み込み

## 仕様上の注意

- 重複チェックは未実装（要件どおり）
- 部分成功時は件数と失敗理由をUI表示
- Deal owner は Contact の `hubspot_owner_id` を使用
