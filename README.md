# tokibot

![tokibot](https://github.com/tokifujp/tokibot/blob/main/screenshot-2026-04-18_20-54-49.png)

> ｺｰﾎｰ…私はtokibot2.0——ソ連が生んだロボ超人・ウォーズマンことTokibotをモデルとしたタスク管理ボットだ。ベアークローでタスクを追加し、パロ・スペシャルでWIPに仕留め、スクリュー・ドライバーで完了に葬る。タスクファイティングコンピューターの異名通り、ときふじの分報チャンネルで確実にタスクをジ・エンドにする。ラーメンマンは食ってやる！ｽｰﾎｰ…

Slack Lists をバックエンドにした UNIX コマンド風タスク管理 Bot。
Google Apps Script で動作し、分報チャンネルでのタスク管理に最適。

## 機能

- Slack Lists とリアルタイム同期
- UNIX コマンド風の操作感
- 終業報告の自動生成
- 期間別の完了タスク確認

## コマンド

| コマンド | 説明 |
|---|---|
| `ls` | タスク一覧を表示 |
| `ls today` / `ls yesterday` / `ls last week` | 完了タスクを期間で表示 |
| `add <タスク名>` | タスクを追加 (todo) |
| `start <番号\|タスク名>` | WIP に変更 |
| `end <番号\|タスク名>` | 完了に変更 |
| `wait <番号\|タスク名>` | 保留に変更 |
| `rm <番号\|タスク名>` | タスクを削除 |
| `:q` / `:wq` / `exit` / `quit` | 本日の終業報告を投稿 |
| `help` | コマンド一覧を表示 |

## セットアップ

### 1. Slack Lists の準備

1. Slack の Files → Lists から新規リストを作成
2. 以下のカラムを用意する:
   - `Name`（テキスト、主キー）
   - `Status`（セレクト: `todo` / `wip` / `done` / `pending`）
3. リストの共有設定を「Editable by anyone in ワークスペース」に変更
4. リストの URL からリスト ID（`F...`）を控えておく

### 2. Slack App の作成

1. https://api.slack.com/apps で新規 App を作成
2. Bot Token Scopes に以下を追加:
   - `channels:history`
   - `chat:write`
   - `lists:read`
   - `lists:write`
3. Event Subscriptions を有効化し `message.channels` を追加
4. ワークスペースにインストールし、Bot User OAuth Token (`xoxb-...`) を控えておく

### 3. GAS のデプロイ

1. Google Apps Script で新規プロジェクトを作成
2. `コード.gs` の内容を貼り付け
3. デプロイ → ウェブアプリ（実行ユーザー: 自分、アクセス: 全員）
4. デプロイ URL を Slack App の Event Subscriptions Request URL に設定し Verified を確認

### 4. Script Properties の設定

GAS の「プロジェクトの設定」→「スクリプト プロパティ」に以下を追加:

| プロパティ | 値 |
|---|---|
| `SLACK_TOKEN` | Bot User OAuth Token (`xoxb-...`) |
| `LIST_ID` | Slack Lists の ID (`F...`) |
| `CHANNEL_ID` | 対象チャンネルの ID (`C...`) |
| `USER_ID` | 自分の Slack User ID (`U...`) |
| `WORKSPACE_DOMAIN` | ワークスペースドメイン（例: `yourcompany`） |

### 5. Bot をチャンネルに招待

```
/invite @<bot名>
```

### 6. 自動メンテナンストリガーの設定

1週間以上前に完了したタスクを毎週月曜に自動削除する `autoClean` のトリガーを設定する。

GAS の「トリガー」→「トリガーを追加」:

| 項目 | 設定値 |
|---|---|
| 実行する関数 | `autoClean` |
| イベントのソース | 時間主導型 |
| タイプ | 毎週（月曜） |
| 時刻 | 午前9時〜10時 |

完了後、削除件数を分報チャンネルに通知する。`ls last week` 等の履歴コマンドへの影響なし（直近7日以内は削除対象外）。

## 注意事項

- Slack Lists は有料プラン（Pro 以上）が必要
- Bot は `USER_ID` で指定したユーザーのメッセージにのみ反応する
- Status カラムのオプション名はスキーマから自動取得するため、カラム名が異なる場合は変更不要
