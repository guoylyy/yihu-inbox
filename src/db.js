// 连接与建表。启动时幂等执行，重复跑、回滚后再跑都不出错
import mysql from 'mysql2/promise'

const TABLES = [
  `CREATE TABLE IF NOT EXISTS inbox_task (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    owner_id INT NOT NULL,
    assignee_id INT NULL,
    title VARCHAR(500) NOT NULL,
    note TEXT NULL,
    due_date DATE NULL,
    priority TINYINT NOT NULL DEFAULT 0,
    tags JSON NOT NULL,
    status ENUM('open','done') NOT NULL DEFAULT 'open',
    done_at DATETIME NULL,
    source ENUM('self','ai','app') NOT NULL DEFAULT 'self',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_owner_status_due (owner_id, status, due_date),
    INDEX idx_assignee_status (assignee_id, status)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS inbox_event (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    task_id BIGINT UNSIGNED NOT NULL,
    actor_id INT NOT NULL,
    action VARCHAR(20) NOT NULL,
    detail JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_task (task_id, created_at)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS inbox_setting (
    user_id INT NOT NULL PRIMARY KEY,
    default_assignee_id INT NULL,
    digest_time VARCHAR(5) NOT NULL DEFAULT '08:00',
    notify_assignee TINYINT(1) NOT NULL DEFAULT 1,
    weekly_push TINYINT(1) NOT NULL DEFAULT 0,
    quick_due VARCHAR(10) NOT NULL DEFAULT 'none',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  // 批量操作的撤销快照：只保留一小时，过期的在下一次批量时清掉
  `CREATE TABLE IF NOT EXISTS inbox_batch (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    actor_id INT NOT NULL,
    action VARCHAR(20) NOT NULL,
    after_value JSON NULL,
    snapshot JSON NOT NULL,
    undo_until DATETIME(3) NOT NULL,
    undone_at DATETIME NULL,
    INDEX idx_actor (actor_id, undo_until)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  // 定时推送的占位：同一轮只有抢到插入的进程发，重启、发版重叠都不会发两次
  `CREATE TABLE IF NOT EXISTS inbox_push_log (
    slot VARCHAR(40) NOT NULL PRIMARY KEY,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
]

// 建表之后新增的列登记在这里：{ table, column, ddl }，ddl 是 ADD COLUMN 后面那段定义
// 回滚只回代码不回库，新列要可空或有默认值
export const ADDED_COLUMNS = [
  { table: 'inbox_task', column: 'archived_at', ddl: 'DATETIME NULL' }
]

/** 所有时间按 UTC 进出库；DATE 保持字符串，避免被驱动按时区挪一天 */
export function createPool(url) {
  const pool = mysql.createPool({ uri: url, connectionLimit: 8, charset: 'utf8mb4', timezone: 'Z', dateStrings: ['DATE'], waitForConnections: true })
  // 隔离级别写死：READ COMMITTED 下 INSERT ... SELECT 不加锁，去重就挡不住并发了
  pool.on('connection', (conn) => conn.query("SET time_zone = '+00:00', transaction_isolation = 'REPEATABLE-READ'"))
  return pool
}

export async function ensureColumn(pool, { table, column, ddl }) {
  const [rows] = await pool.execute(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  )
  if (rows.length) return false
  await pool.query('ALTER TABLE ?? ADD COLUMN ?? ' + ddl, [table, column])
  return true
}

export async function ensureSchema(pool, columns = ADDED_COLUMNS) {
  for (const sql of TABLES) await pool.query(sql)
  for (const c of columns) await ensureColumn(pool, c)
}
