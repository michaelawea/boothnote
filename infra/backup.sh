#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
#  备份 —— R13：单台机器，冗余不靠第二台，全靠这个脚本。
#
#  🔴 **2026-08-07 重做（D79）。** 原来是「每天 03:00 一次 pg_dump，留 14 天」。
#     那个设计的 RPO 是 **24 小时** —— 而当天在开发环境实测到
#     `provision-twenty.mjs` 会静默清空三列数据（§2.28）。同样的事若发生在生产、
#     下午三点触发，回退到最近一次备份要丢掉**半天的展会记录**，
#     而那是全项目唯一不可再生的资产。
#
#     判据：**能丢多少（RPO）比能回退多久（保留期）重要得多。**
#     「96 小时回退」是保留期；真正救命的是「能不能回到那个脚本跑之前」。
#
#  三档保留（GFS，业界常规做法）：
#     daily    每天         保留 14 天      ← 默认节奏，RPO = 24 小时
#     weekly   每周日       保留 8 周
#     labeled  变更前自动    **永不自动删**  ← deploy.sh 在迁移/provision 前打，
#                                            今天这类「脚本把数据清了」的事故靠它回退
#
#  ⚠️ 还有一个 `--quick` 档（每 15 分钟 / 留 96 小时），**默认不装 cron**。
#     维护者 2026-08-07：「搞成 daily 吧，quick 这个有点太占用内存了」。
#     代价说明白：**默认 RPO 因此是 24 小时**，也就是最坏情况丢一天的记录。
#     🔴 **展会那 10 天建议打开它** —— 那 10 天的录音是全项目唯一不可再生的资产，
#        而 dump 一次约 1 MB（96 小时 ≈ 380 MB），比丢半天记录便宜得多。
#
#  用法：
#     ./infra/backup.sh                     完整备份（daily 档，含音频归档）
#     ./infra/backup.sh --quick             高频档（只 dump + 音频增量镜像）
#     ./infra/backup.sh --label pre-deploy-abc1234    打标签，进 labeled 档
#     ./infra/backup.sh --verify            恢复演练：把最新 dump 灌进临时库对行数
#
#  cron（见 docs/deploy.md §7.3；服务器上仓库在 /opt/boothnote）：
#     */15 * * * * /opt/boothnote/infra/backup.sh --quick  >> /var/log/boothnote-backup.log 2>&1
#     0 3 * * *    /opt/boothnote/infra/backup.sh          >> /var/log/boothnote-backup.log 2>&1
#     0 4 * * 0    /opt/boothnote/infra/backup.sh --verify >> /var/log/boothnote-backup.log 2>&1
#     # 展会那 10 天把 */15 改成 */5
#
#  🔴 **第三条（每周恢复演练）不是可选的。**
#     这个脚本自己写着「没恢复过的备份不算备份」，但 `--verify` 原来**只能手动跑** ——
#     于是它在写完那天被跑过一次，然后再也没有。备份最恶劣的失败模式是
#     「一直在跑、一直有文件、而那些文件恢复不出来」，只有定期真的灌一次才知道。
#     排在 daily（03:00）之后一小时，验的就是当天最新那份。
# ══════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

MODE=full
LABEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quick)  MODE=quick ;;
    --verify) MODE=verify ;;
    --label)  MODE=labeled; LABEL="${2:?--label 后面要跟一个名字}"; shift ;;
    *) echo "不认识的参数：$1" >&2; exit 2 ;;
  esac
  shift
done

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT=${BACKUP_DIR:-./backups}
PGUSER_=${PG_DATABASE_USER:-postgres}
KEEP_HOURS=${BACKUP_KEEP_HOURS:-96}    # quick 档（默认不装 cron，展会期间才开）
KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
KEEP_WEEKS=${BACKUP_KEEP_WEEKS:-8}

mkdir -p "$OUT"/{quick,daily,weekly,labeled,audio-mirror}

# ── 恢复演练 ──────────────────────────────────────────────────────────
# 🔴 **没有恢复过的备份不算备份。** 这一段把最新的 boothnote dump 真的灌进一个
#    临时库，再逐表比对行数 —— 只看文件大小不算数：gzip 一个空 dump 也有几十字节。
if [ "$MODE" = verify ]; then
  LATEST=$(ls -1t "$OUT"/quick/boothnote-*.sql.gz "$OUT"/daily/boothnote-*.sql.gz 2>/dev/null | head -1 || true)
  [ -n "$LATEST" ] || { echo "❌ 一个 boothnote 备份都没有"; exit 1; }
  SCRATCH="restore_check_$(date -u +%s)"
  echo "🔍 恢复演练：$LATEST → 临时库 $SCRATCH"
  docker compose exec -T db psql -U "$PGUSER_" -d postgres -c "create database \"$SCRATCH\"" >/dev/null
  # shellcheck disable=SC2064
  trap "docker compose exec -T db psql -U '$PGUSER_' -d postgres -c 'drop database if exists \"$SCRATCH\"' >/dev/null 2>&1 || true" EXIT
  gunzip -c "$LATEST" | docker compose exec -T db psql -U "$PGUSER_" -d "$SCRATCH" -q >/dev/null

  BAD=0
  for T in inbox staging app_user thread thread_message attachment; do
    LIVE=$(docker compose exec -T db psql -U "$PGUSER_" -d boothnote     -tAc "select count(*) from $T" 2>/dev/null || echo ERR)
    REST=$(docker compose exec -T db psql -U "$PGUSER_" -d "$SCRATCH" -tAc "select count(*) from $T" 2>/dev/null || echo ERR)
    # 备份是过去某一刻的，所以恢复出来的行数**只能少不能多**，且不能是 0/报错
    if [ "$REST" = ERR ] || [ "$REST" = 0 ] && [ "$LIVE" != 0 ]; then
      echo "  ❌ $T：线上 $LIVE，恢复出来 $REST"; BAD=1
    else
      echo "  ✅ $T：线上 $LIVE，恢复出来 $REST"
    fi
  done
  [ "$BAD" = 0 ] && echo "🟢 恢复演练通过" || { echo "🔴 恢复演练失败 —— 这份备份救不了你"; exit 1; }
  exit 0
fi

# ── 备份目的地 ────────────────────────────────────────────────────────
case "$MODE" in
  quick)   DEST="$OUT/quick";   PREFIX="" ;;
  labeled) DEST="$OUT/labeled"; PREFIX="${LABEL}-" ;;
  *)       DEST="$OUT/daily";   PREFIX="" ;;
esac

echo "[$STAMP] 备份开始（$MODE）"

# ── 1. 两个库都要：Twenty 的 default + 我们的 boothnote ────────────────────
# 实测体量（2026-08-07）：default ≈ 760 KB.gz，boothnote ≈ 175 KB.gz。
# 所以 15 分钟一次完全负担得起：96 小时 × 4 次/时 × 1 MB ≈ 380 MB。
for DB in default boothnote; do
  F="$DEST/${PREFIX}${DB}-${STAMP}.sql.gz"
  docker compose exec -T db pg_dump -U "$PGUSER_" "$DB" | gzip > "$F"
  # 🔴 大小守卫：gzip 一个失败的空输出也会产生一个几十字节的「文件」。
  #    不查这一下，「备份天天在跑」和「备份天天在产生空文件」长得一模一样。
  SZ=$(wc -c < "$F")
  [ "$SZ" -gt 1024 ] || { echo "  ❌ $DB 的 dump 只有 $SZ 字节 —— 当作失败"; rm -f "$F"; exit 1; }
  echo "  ✅ $DB → $(du -h "$F" | cut -f1)"
done

# ── 2. 音频 + agent-sessions：增量镜像 ────────────────────────────────
# 🔴 `pg_dump` 不含音频。展会 10 天说过的话是唯一不可再生的资产，
#    光备份数据库等于没备份。
#
# ⚠️ 这里是**镜像同步**不是打包：音频文件写下去就不再改（append-only），
#    所以每次只复制新增的那些，代价 O(新文件)。
#    原来的做法是每次打一个全量 tar —— 那在 15 分钟一次的频率下会把盘写满，
#    而且音频的 RPO 会被钉死在 24 小时（tar 只有 daily 档才打）。
#    `agent-sessions/`（D73）就在这个卷里，一并覆盖。
#
# 🔴 **这一步跑在 `postgres:16` 里，不是网关镜像里 —— 这不是随手选的。**
#
#    网关是 `node:24-alpine`，里面是 **busybox**。2026-08-07 逐个实测，
#    busybox 上**没有一种写法**能做对「增量复制、不覆盖已有」：
#      · `cp -a -n /src/. /dst/`        → 复制 0 个文件，**exit 0**
#      · `cp -rn /src/* /dst/`          → 已存在的目录整个跳过，里面的新文件漏掉
#      · `tar -cf - . | tar -xf - -k`   → 碰到第一个已存在的文件就**中止**，后面的新文件全丢
#    三种都是「看起来成功了，其实没复制」。而 `postgres:16` 是 Debian 底，
#    GNU coreutils 的 `cp -a -n` 语义正确，**且这个镜像服务器上本来就有**（db 服务在用）。
#
#    这段弯路值得记下来：**备份脚本里每一条命令都要验「第二次跑」的行为。**
#    第一次跑什么都对，第二次开始才暴露 —— 而备份恰恰是从第二次开始才有意义的东西。
# ⚠️ 匹配到多个就**报错**，不 `head -1` 挑一个。
#    挑错了的后果是「备份了一个空卷」，而它同样 exit 0 ——
#    这个歧义在写这段的当天就真的咬了一次（一个残留的测试卷和真卷同时匹配）。
AUDIO_VOLS=$(docker volume ls -q 2>/dev/null | grep -E '(^|_)audio-data$' || true)
AUDIO_VOL=$(echo "$AUDIO_VOLS" | grep -c . >/dev/null; echo "$AUDIO_VOLS" | head -1)
if [ "$(echo "$AUDIO_VOLS" | grep -c .)" -gt 1 ]; then
  echo "  ❌ 匹配到多个音频卷，不知道该备份哪个："; echo "$AUDIO_VOLS" | sed 's/^/       /'
  echo "     用 AUDIO_VOLUME=<卷名> 明确指定，或删掉多余的卷"; exit 1
fi
AUDIO_VOL=${AUDIO_VOLUME:-$AUDIO_VOL}
if [ -n "$AUDIO_VOL" ]; then
  BEFORE=$(find "$OUT/audio-mirror" -type f 2>/dev/null | wc -l | tr -d ' ')
  docker run --rm \
    -v "$AUDIO_VOL":/src:ro \
    -v "$(cd "$OUT" && pwd)/audio-mirror":/mirror \
    postgres:16 sh -c 'cp -a -n /src/. /mirror/ 2>/dev/null; true'
  SRC_N=$(docker run --rm -v "$AUDIO_VOL":/src:ro postgres:16 sh -c 'find /src -type f | wc -l' | tr -d ' ')
  N=$(find "$OUT/audio-mirror" -type f 2>/dev/null | wc -l | tr -d ' ')
  # 🔴 卷里有文件而镜像是空的 = 同步坏了。**必须炸**，不能只是少打一行日志：
  #    「备份天天在跑」和「备份天天在产生空目录」在外面看来一模一样。
  if [ "$SRC_N" -gt 0 ] && [ "$N" -eq 0 ]; then
    echo "  ❌ 音频卷里有 $SRC_N 个文件，镜像却是空的 —— 同步坏了，不要当成功"; exit 1
  fi
  echo "  ✅ 音频镜像 → $N 个文件（新增 $(( N - BEFORE ))）· $(du -sh "$OUT/audio-mirror" 2>/dev/null | cut -f1) · 源 $SRC_N 个"
else
  echo "  ⚠️  找不到 audio-data 卷 —— 本地开发时音频在宿主机 data/audio，属正常"
fi

# 自包含的音频归档只在 daily / labeled 打一份 —— 镜像目录方便日常，
# 但它不是一个可以整体搬走的东西，异地推送要的是这个 tar。
if [ "$MODE" != quick ]; then
  AF="$DEST/${PREFIX}audio-${STAMP}.tar.gz"
  if [ -d "$OUT/audio-mirror" ] && [ -n "$(ls -A "$OUT/audio-mirror" 2>/dev/null)" ]; then
    tar -cz -C "$OUT/audio-mirror" . > "$AF"
    echo "  ✅ 音频归档 → $(du -h "$AF" | cut -f1)"
  else
    echo "  ⚠️  音频镜像是空的 —— 没有归档可打"
  fi
fi

# ── 3. 每周日把当天的 daily 提升成 weekly ─────────────────────────────
if [ "$MODE" = full ] && [ "$(date -u +%u)" = 7 ]; then
  cp "$DEST"/*-"${STAMP}".* "$OUT/weekly/" 2>/dev/null || true
  echo "  ✅ 周日 —— 已提升为 weekly 档"
fi

# ── 4. 推到欧盟区对象存储（R5：数据留欧盟 · T21）───────────────────────
# 🔴 **本地副本不算备份。** 三份 dump 和数据库在同一块盘上，
#    机器没了就一起没了 —— 3-2-1 里的「1 份异地」是唯一能救「整机丢失」的那一份。
if [ -n "${BACKUP_REMOTE:-}" ] && command -v rclone >/dev/null; then
  rclone copy "$DEST" "$BACKUP_REMOTE/$(basename "$DEST")" --include "*-${STAMP}.*"
  echo "  ✅ 已推送到 $BACKUP_REMOTE"
else
  echo "  ⚠️  未配置 BACKUP_REMOTE —— 只有本地副本。机器挂了就一起没了（T21）。"
fi

# ── 5. 按档清理 ───────────────────────────────────────────────────────
# ⚠️ 别写成 `[ ... ] && rm && echo` 的链式判断：没有过期文件时它返回 1，
#    在 `set -e` 下会让整个脚本在这里中止 —— 备份其实做完了，退出码却是 1（2026-07-31 实测）。
# 🔴 `labeled/` **不参与清理**：那是变更前的救命绳，只能人手删。
find "$OUT/quick"  -type f -mmin  +$(( KEEP_HOURS * 60 )) -delete 2>/dev/null || true
find "$OUT/daily"  -type f -mtime +"$KEEP_DAYS"           -delete 2>/dev/null || true
find "$OUT/weekly" -type f -mtime +$(( KEEP_WEEKS * 7 ))  -delete 2>/dev/null || true

# ── 6. 成功标记 ───────────────────────────────────────────────────────
# 🔴 监控要能回答「备份是不是已经停了三天」。没有这个文件的话，
#    cron 静默失败和「一切正常」在外部看来完全一样 ——
#    这个仓库最贵的那类 bug 就长这个样子。
date -u +%Y-%m-%dT%H:%M:%SZ > "$OUT/LAST_OK_$MODE"
echo "[$STAMP] 完成（quick 档保留 ${KEEP_HOURS}h · daily ${KEEP_DAYS}d · weekly ${KEEP_WEEKS}w · labeled 永久）"
