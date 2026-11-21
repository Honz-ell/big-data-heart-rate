# WESAD Stress Edge (prototype)

Nguyên mẫu xử lý dữ liệu cảm biến cổ tay WESAD theo luồng, hướng tới phân loại trạng thái Stress / Non-Stress trên thiết bị mô phỏng.

## Phạm vi giai đoạn đầu

1. Đọc dữ liệu Empatica E4 từ các thư mục `S*_E4_Data`.
2. Chuẩn hóa từng mẫu thành sự kiện có người tham gia, cảm biến, thời điểm và giá trị.
3. Phát lại dữ liệu mẫu vào Apache Kafka bằng Python Producer.
4. Spark Structured Streaming tổng hợp dữ liệu; Edge mô phỏng dự đoán theo cửa sổ và có thể lưu kết quả vào PostgreSQL để Grafana trực quan hóa.

Đây là nguyên mẫu học tập, không dùng để chẩn đoán hoặc đưa ra quyết định y tế.

## Dữ liệu

Không chép dữ liệu WESAD vào Git. Đặt đường dẫn dữ liệu giải nén khi chạy lệnh. Mặc định hiện tại là `D:\btldll\archive\WESAD`; có thể đổi bằng đối số đường dẫn.

Các file E4 được đọc ở dạng CSV. `ACC`, `BVP`, `EDA`, `HR` và `TEMP` có phần đầu mô tả thời điểm bắt đầu/tần số lấy mẫu; `IBI` có thời điểm tương đối và khoảng giữa các nhịp. `tags.csv` có thể rỗng.

## Chạy kiểm kê dữ liệu

Mở PowerShell:

```powershell
cd D:\btldll\wesad-stress-edge
python scripts\inspect_dataset.py D:\btldll\archive\WESAD
```

Lệnh trên chỉ đọc dữ liệu và in số lượng mẫu, file thiếu hoặc file rỗng. Nó không sửa thư mục dataset.

## Chạy Kafka và phát thử dữ liệu

Tạo môi trường Python và cài thư viện Producer:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Khởi động Kafka:

```powershell
docker compose up -d kafka
```

Tạo topic:

```powershell
docker exec wesad-kafka /opt/kafka/bin/kafka-topics.sh --create --if-not-exists --topic wearable.sensor.v1 --bootstrap-server localhost:9092 --partitions 1 --replication-factor 1
```

Phát tối đa 1.000 mẫu từ S2. `--speed 60` phát lại nhanh hơn thời gian ghi trong dữ liệu 60 lần:

```powershell
.\.venv\Scripts\python.exe scripts\produce_e4.py --subject S2 --speed 60 --limit 1000
```

Xem thử 10 bản ghi trong topic ở terminal khác:

```powershell
docker exec wesad-kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic wearable.sensor.v1 --from-beginning --max-messages 10
```

Tắt Kafka khi kết thúc:

```powershell
docker compose down
```

## Chạy Spark Structured Streaming và monitoring

Spark chạy trong Apache Spark Docker image, nên không cần cài Java/Spark trực tiếp trên Windows. Compose khởi động Spark, Kafka, PostgreSQL, Prometheus, cAdvisor và JMX Exporter cùng Grafana. Spark gom dữ liệu Kafka theo cửa sổ 10 giây rồi ghi số mẫu, trung bình, thấp nhất và cao nhất của từng cảm biến vào PostgreSQL. Checkpoint nằm trong `checkpoints/spark-postgres`, vì vậy lần chạy sau tiếp tục từ offset đã xử lý. Mẫu TEMP ngoài khoảng 20–45 °C bị loại.

Nếu Spark đang chạy bằng lệnh `docker run` cũ trong một terminal, nhấn `Ctrl+C` ở terminal đó trước để tránh chạy hai Spark consumer cùng ghi vào PostgreSQL. Áp dụng schema một lần nếu database chưa có các bảng mới (các lệnh `IF NOT EXISTS` giữ nguyên bảng dự đoán hiện tại):

```powershell
docker cp .\sql\001_init.sql wesad-postgres:/tmp/001_init.sql
docker exec wesad-postgres psql -v ON_ERROR_STOP=1 -U wesad -d wesad -f /tmp/001_init.sql
```

Khởi động toàn bộ hệ thống cùng các dịch vụ monitoring:

```powershell
docker compose --profile monitoring up -d --build
docker compose --profile monitoring ps
```

Lần đầu, Spark tải Kafka connector/JDBC driver và image JMX Exporter được tạo nên có thể mất vài phút. Spark dùng cache Ivy có quyền ghi tại `/tmp/.ivy2` để dependency resolver không ghi vào thư mục `/nonexistent` mặc định của image. Compose có thể tạo lại Kafka để áp dụng cấu hình JMX; Kafka hiện chưa dùng volume lưu dữ liệu, nên các record cũ trong topic có thể mất. PostgreSQL vẫn giữ dữ liệu dự đoán trong volume. Nếu topic trống, phát lại WESAD từ giao diện hoặc bằng `scripts\produce_e4.py`.

Mở các trang sau để xem dịch vụ và metrics:

- Grafana: [http://localhost:3000](http://localhost:3000) → Dashboards → WESAD → **WESAD · System Monitoring**.
- Prometheus targets: [http://localhost:9090/targets](http://localhost:9090/targets). Các job `kafka-jmx`, `spark` và `cadvisor` cần ở trạng thái `UP`.
- Spark UI: [http://localhost:4040](http://localhost:4040).

Dashboard monitoring hiển thị tốc độ record/byte qua Kafka, input/processing rate và thời gian micro-batch của Spark, độ trễ request Kafka p95, cùng CPU/RAM container. Để các biểu đồ có dữ liệu, phát replay WESAD khi Spark đang chạy. Spark metrics được đọc từ progress của Structured Streaming; thời gian micro-batch là thời gian xử lý trong Spark, không phải độ trễ từ lúc cảm biến ghi mẫu.

Khi dòng `Đã ghi micro-batch Spark ...` xuất hiện, có thể kiểm tra bảng tổng hợp bằng:

```powershell
docker exec wesad-postgres psql -U wesad -d wesad -c "SELECT subject_id, window_start_utc, sensor, sample_count, mean_value FROM sensor_window_aggregates ORDER BY window_start_utc LIMIT 20;"
```

Spark chạy liên tục để nhận thêm sự kiện. Tắt các container bằng `docker compose --profile monitoring stop`; lần sau bật lại bằng `docker compose --profile monitoring start`. Không xóa thư mục checkpoint nếu muốn Spark tiếp tục từ offset đã xử lý.

## Huấn luyện baseline Stress / Non-Stress

WESAD gắn nhãn đồng bộ với tín hiệu; trong bước này chỉ dùng dữ liệu cổ tay trong `.pkl`. Nhãn `2` là Stress; nhãn `1`, `3`, `4` được gom thành Non-Stress; nhãn chuyển tiếp/khác bị loại. Tín hiệu được chia thành cửa sổ 30 giây, rút trích mean/std/min/max cho ACC magnitude, BVP, EDA và TEMP. Cửa sổ phải có ít nhất 80% nhãn cùng một phía. Việc tách tập theo người tham gia tránh để dữ liệu cùng một người vừa xuất hiện trong train vừa xuất hiện trong test. WESAD cung cấp các tín hiệu cổ tay Empatica E4 và các điều kiện baseline, stress, amusement, meditation trong thí nghiệm gốc. [Bài báo WESAD](https://ubi29.informatik.uni-siegen.de/usi/pdf/ubi_icmi2018.pdf)

Cài các thư viện bổ sung vào môi trường Python rồi huấn luyện:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe scripts\train_stress_model.py --data-root D:\btldll\archive\WESAD
```

Mặc định script đọc tín hiệu wrist từ `.pkl`, đánh giá bằng Leave-One-Subject-Out (mỗi lượt giữ lại một người hoàn toàn), rồi lưu model cuối trong `models\stress_rf.joblib`. Để huấn luyện từ cùng các giá trị E4 CSV mà Producer gửi vào Kafka, dùng `--feature-source csv` và đường dẫn output riêng:

```powershell
.\.venv\Scripts\python.exe scripts\train_stress_model.py --data-root D:\btldll\archive\WESAD --feature-source csv --output models\stress_rf_csv.joblib
```

So sánh kết quả LOSO của hai nguồn trước khi chọn model cho Edge. Dù dùng nguồn nào, đây vẫn là baseline học thuật; cần báo cáo recall, ma trận nhầm lẫn và độ lệch giữa người tham gia, không xem là xác nhận dùng lâm sàng.

Để chạy thử một người chưa tham gia huấn luyện, loại người đó khỏi tập train rồi nạp model riêng ở Edge. Ví dụ giữ S4 làm người kiểm tra độc lập:

```powershell
.\.venv\Scripts\python.exe scripts\train_stress_model.py --data-root D:\btldll\archive\WESAD --exclude-subject S4 --output models\stress_rf_no_s4.joblib
.\.venv\Scripts\python.exe scripts\edge_inference.py --subject S4 --model models\stress_rf_no_s4.joblib --starting-offsets latest --consumer-group edge-s4-heldout-demo --store-postgres
```

Model này được huấn luyện trên các participant còn lại; các chỉ số LOSO trong lần chạy cũng chỉ tính trên nhóm còn lại. Script đồng thời in confusion matrix và các chỉ số trên toàn bộ cửa sổ của participant bị loại, để đối chiếu kết quả Edge với đánh giá ngoại mẫu đầy đủ hơn.

## Đăng ký và phân phối phiên bản model

Model Registry lưu phiên bản, checksum SHA-256, chỉ số đánh giá và model đang active trong PostgreSQL. Edge có thể hỏi registry định kỳ, tải model active, kiểm tra checksum/schema rồi thay model đang dùng giữa các cửa sổ.

Khởi động API, đăng model hiện tại làm phiên bản đầu, rồi xem model active:

```powershell
docker compose up -d --build model-registry
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe scripts\publish_model.py --file models\stress_rf_no_s4_eval.joblib --version v1.0.0 --activate
Invoke-RestMethod http://localhost:8000/models/active
```

Chạy Edge với registry để nhận cập nhật phiên bản:

```powershell
.\.venv\Scripts\python.exe scripts\edge_inference.py --subject S4 --model models\stress_rf_no_s4_eval.joblib --model-registry-url http://localhost:8000 --model-poll-seconds 5 --starting-offsets latest --consumer-group edge-s4-registry-demo --store-postgres
```

Khi cần phát hành phiên bản mới, đăng model bằng version mới và `--activate`; Edge sẽ nhận ở lần poll kế tiếp. Mỗi dự đoán mới lưu cả tên file và version vào PostgreSQL.

## Chạy giao diện điều khiển thiết bị

Giao diện Next.js chạy ở cổng `3001` để không trùng Grafana (`3000`). Cần bật Kafka, PostgreSQL và Model Registry trước; PostgreSQL phải có ít nhất một model active trong Registry. Mở ba terminal PowerShell tại thư mục dự án.

**Terminal 1 – dịch vụ dữ liệu, Model Registry, Spark và monitoring:**

```powershell
docker compose --profile monitoring up -d --build
```

**Terminal 2 – Device Manager API:** API này liệt kê participant trong WESAD, khởi động/dừng Producer và Edge, đọc log và lấy lịch sử dự đoán từ PostgreSQL.

```powershell
cd D:\btldll\wesad-stress-edge
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn scripts.device_manager_api:app --host 127.0.0.1 --port 8001
```

Mặc định API tìm dữ liệu tại `D:\btldll\archive\WESAD`. Nếu dữ liệu nằm chỗ khác, đặt biến môi trường trước khi chạy Uvicorn:

```powershell
$env:WESAD_DATA_ROOT = "D:\duong-dan\toi\WESAD"
```

**Terminal 3 – giao diện web:**

```powershell
cd D:\btldll\wesad-stress-edge
npm install
npm run dev
```

Mở [http://localhost:3001](http://localhost:3001). Chọn participant, offset, thời lượng và tốc độ rồi nhấn **Start replay**. Device Manager bật Edge trước, sau đó phát lại cửa sổ WESAD vào Kafka. Trang tự làm mới trạng thái, log, model active và kết quả từ PostgreSQL mỗi 3 giây. Nút **Stop** dừng Producer và Edge của participant đó. Có thể kích hoạt phiên bản model ngay trong thẻ **Model Registry**; Edge đang chạy sẽ nhận phiên bản mới trong lần poll tiếp theo.

Đây là giao diện điều khiển nguyên mẫu chạy trên cùng máy. Nút Start phát lại file WESAD đã thu, không kết nối đồng hồ thật. Grafana vẫn ở [http://localhost:3000](http://localhost:3000); Spark và các dịch vụ monitoring do Compose quản lý theo phần trước.

## Chạy mô phỏng suy luận ở Edge

Mỗi process giả lập một thiết bị: chỉ giữ sự kiện có `subject_id` trùng với `--subject`, gom đủ bốn cảm biến trong cửa sổ 30 giây, rồi nạp model cục bộ để in Stress/Non-Stress và điểm mô hình Stress. Điểm này chưa được hiệu chuẩn như xác suất sức khỏe. Mở một terminal cho Edge trước:

```powershell
.\.venv\Scripts\python.exe scripts\edge_inference.py --subject S4
```

Model mặc định được huấn luyện trên tín hiệu wrist trong `.pkl`, nên khi kiểm thử suy luận hãy phát từ cùng nguồn này bằng `--source pickle`:

```powershell
.\.venv\Scripts\python.exe scripts\produce_e4.py --subject S4 --source pickle --speed 60 --limit 7000
```

Edge sẽ bỏ các cửa sổ thiếu mẫu. Chỉ số LOSO hiện cho thấy mức nhận diện Stress thay đổi khá nhiều giữa người; kết quả trên màn hình là mô phỏng học thuật, chưa nên hiểu như cảnh báo đáng tin cậy cho người dùng thật.

Có thể truyền --label-class non-stress để tìm cửa sổ Non-Stress, hoặc truyền --model models\stress_rf_no_s4_eval.joblib để in dự đoán và điểm Stress của model cho từng cửa sổ.

## Demo một đoạn có nhãn Stress

Liệt kê các cửa sổ 30 giây mà nhãn WESAD có ít nhất 80% mẫu Stress. Ví dụ với S4:

```powershell
.\.venv\Scripts\python.exe scripts\list_stress_windows.py --subject S4
```

Chọn một `offset_seconds` được in ra. Mở terminal thứ nhất và cho Edge chỉ nghe bản phát mới với một consumer group riêng:

```powershell
.\.venv\Scripts\python.exe scripts\edge_inference.py --subject S4 --starting-offsets latest --consumer-group edge-s4-stress-demo --store-postgres
```

Sau khi Edge báo đang nghe, chạy ở terminal thứ hai, thay `OFFSET` bằng số vừa lấy từ danh sách:

```powershell
.\.venv\Scripts\python.exe scripts\produce_e4.py --subject S4 --source pickle --speed 60 --start-offset-seconds OFFSET --duration-seconds 40 --limit 0
```

Đoạn phát có 40 giây để Edge nhận đủ một cửa sổ 30 giây và một ít mẫu tiếp theo để chốt cửa sổ. Thêm `--source pickle` để dữ liệu phát vào Kafka cùng nguồn với model mặc định. Lệnh này chỉ phát lại dữ liệu đã ghi trong WESAD, không phải cảm biến trực tiếp. Dự đoán trên cùng người đã dùng để huấn luyện chỉ là minh họa luồng; dùng kết quả LOSO để báo cáo khả năng tổng quát hóa.

Nếu dự đoán khác nhãn WESAD, so sánh đặc trưng lấy từ `.pkl` (đường huấn luyện) và E4 CSV (đường streaming) cho chính cửa sổ đó:

```powershell
.\.venv\Scripts\python.exe scripts\compare_e4_pickle_window.py --subject S4 --offset-seconds 3630
```

Lệnh in số mẫu và sai khác đặc trưng từng cảm biến, cùng điểm mô hình của cả hai nguồn. Điều này giúp phân biệt lỗi căn chỉnh/khác nguồn tín hiệu với trường hợp mô hình bỏ sót Stress.

## Lưu dự đoán vào PostgreSQL và xem trên Grafana

Khởi động PostgreSQL và Grafana (Kafka đang chạy từ bước trước):

```powershell
docker compose --profile monitoring up -d postgres grafana prometheus spark-aggregator
```

Cài driver PostgreSQL cho Python:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Chạy Edge và bật lưu kết quả. Vì topic đang có dữ liệu S4 đã phát trước đó, lệnh sẽ đọc lại từ đầu, lọc S4, rồi lưu các cửa sổ hoàn chỉnh:

```powershell
.\.venv\Scripts\python.exe scripts\edge_inference.py --subject S4 --store-postgres
```

Khi đã thấy dòng `Đã lưu cửa sổ dự đoán vào PostgreSQL` cho các cửa sổ, nhấn `Ctrl+C`. Kiểm tra số dòng đã lưu:

```powershell
docker exec wesad-postgres psql -U wesad -d wesad -c "SELECT subject_id, window_start, prediction, model_score_stress FROM stress_predictions ORDER BY window_start;"
```

Mở [http://localhost:3000](http://localhost:3000), đăng nhập `admin` / `admin`, rồi đổi mật khẩu khi được yêu cầu. Datasource PostgreSQL đã được cấu hình sẵn. Tạo Dashboard → Add visualization → chọn `WESAD PostgreSQL`, chuyển sang SQL và dùng truy vấn sau để xem điểm Stress theo thời gian:

```sql
SELECT window_start AS "time", model_score_stress, subject_id
FROM stress_predictions
WHERE $__timeFilter(window_start)
ORDER BY window_start;
```

Chọn kiểu biểu đồ Time series. Điểm này là đầu ra của mô hình thử nghiệm, không phải xác suất sức khỏe đã được hiệu chuẩn.

Để thêm biểu đồ thống kê cảm biến do Spark tạo, tạo một visualization khác, chọn `WESAD PostgreSQL`, chọn **Code**, đặt **Format = Time series**, rồi dùng ví dụ sau (đổi `TEMP` thành `EDA`, `BVP` hoặc cảm biến muốn xem):

```sql
WITH latest AS (
  SELECT DISTINCT ON (subject_id, window_start_utc, sensor, unit)
    subject_id, window_start_utc, sensor, unit, mean_value
  FROM sensor_window_aggregates
  WHERE $__timeFilter(window_start_utc)
  ORDER BY subject_id, window_start_utc, sensor, unit, ingested_at DESC, spark_batch_id DESC
)
SELECT window_start_utc AS "time", mean_value
FROM latest
WHERE subject_id = 'S4' AND sensor = 'TEMP'
ORDER BY window_start_utc;
```

## Giao diện Web theo dõi sức khỏe & vận hành (WESAD Pulse & Stress Companion)

Giao diện Next.js cung cấp **2 góc nhìn song song** trên cùng một luồng dữ liệu:

1. **Tab Theo dõi Sức khỏe & Cảnh báo (hướng người dùng đeo đồng hồ)**:
   - Hiển thị các chỉ số sinh tồn dễ hiểu: **Nhịp tim hiện tại (`BPM` so với mức nền nghỉ cá nhân)**, **Biến thiên nhịp tim (`HRV · RMSSD` bằng ms)**, **Chỉ số Căng thẳng Tổng hợp (`0–100`)**, **Độ dẫn điện da (`EDA µS`)**, **Nhiệt độ cổ tay (`°C`)** và **Bối cảnh vận động (`Ngồi tĩnh` / `Vận động nhẹ` / `Đang vận động mạnh`)**.
   - **Biểu đồ sinh lý đa tốc độ**: kết hợp trực tiếp đường chỉ số sinh tồn mỗi **10 giây từ Spark Structured Streaming (`sensor_window_aggregates`)** với các vùng phân loại **30 giây từ AI tại Edge (`stress_predictions`)**.
   - **Chống báo động giả & cảnh báo có giải thích**: tự động khóa cảnh báo stress giả khi gia tốc cổ tay ghi nhận đang tập thể dục/đi bộ nhanh; chỉ kích hoạt cảnh báo căng thẳng kéo dài khi vượt ngưỡng liên tiếp qua nhiều cửa sổ, kèm mã lý do sinh lý tiếng Việt, bài hít thở điều hòa `4-4-6` và nút xác nhận phản hồi người đeo (`prediction_feedback`).
   - **4 kịch bản mẫu 1-Click** (*Làm việc thư giãn*, *Áp lực thuyết trình TSST*, *Chuyển pha Áp lực → Phục hồi*, *Đi bộ nhanh / Chống báo giả*).
2. **Tab Vận hành Pipeline & Model Registry (hướng kỹ sư dữ liệu / MLOps)**:
   - Tùy chỉnh `offset`, `duration`, `speed`, theo dõi log trực tiếp của `produce_e4.py` và `edge_inference.py`, kiểm tra bảng micro-batch 10s của Spark và chuyển đổi nóng (hot-swap) phiên bản mô hình `v1.0.0 ↔ v1.1.0`.

### Chạy với cụm Docker đầy đủ (Kafka + Spark + PostgreSQL)

Sau khi bật `docker compose --profile monitoring up -d --build`, mở thêm 2 terminal:

```powershell
# Terminal 1: Khởi chạy Device Manager & Health Telemetry API trên cổng 8001
.\.venv\Scripts\python.exe -m uvicorn scripts.device_manager_api:app --host 0.0.0.0 --port 8001
```

```powershell
# Terminal 2: Khởi chạy giao diện Next.js trên cổng 3001
npm install
npm run dev
```

Mở trình duyệt tại [http://localhost:3001](http://localhost:3001). Next.js tự động proxy `/api/device/*` sang `:8001` và `/api/registry/*` sang `:8000`.

### Chế độ Trình diễn Nhanh không cần dữ liệu 2.5 GB (`WESAD_DEMO_MODE=1`)

Khi muốn trình diễn nhanh giao diện hoặc kiểm thử trên máy chưa tải bộ WESAD 2.5 GB, bật biến môi trường `WESAD_DEMO_MODE=1` (vẫn chạy mô hình Random Forest thật trong `models/` trên sóng sinh lý E4 tổng hợp):

```powershell
$env:WESAD_DEMO_MODE="1"
.\.venv\Scripts\python.exe -m uvicorn wesad.model_registry:app --app-dir src --host 0.0.0.0 --port 8000
.\.venv\Scripts\python.exe -m uvicorn scripts.device_manager_api:app --host 0.0.0.0 --port 8001
npm run dev
```

## Cấu trúc

```text
src/wesad/e4_reader.py        Đọc từng mẫu E4 CSV, không nạp toàn bộ cảm biến vào RAM
src/wesad/pickle_reader.py    Phát tín hiệu wrist pickle đồng bộ + suy diễn kênh HR 1 Hz từ BVP
src/wesad/features.py         Định nghĩa 16 đặc trưng miền thời gian dùng chung cho train và Edge
src/wesad/vitals.py           Trích xuất nhịp tim (BPM), HRV (RMSSD), bối cảnh vận động & mã giải thích
src/wesad/demo_simulator.py   Danh mục 4 kịch bản thực tế & bộ phát sóng E4 cho chế độ trình diễn
src/wesad/model_registry.py   FastAPI Model Registry quản lý phiên bản, SHA-256 và hot-swap model
src/spark/aggregate_stream.py Spark đọc Kafka, tổng hợp cửa sổ 10 giây và xuất Prometheus metrics
scripts/inspect_dataset.py    Kiểm kê thư mục dataset WESAD
scripts/produce_e4.py         Phát lại dữ liệu đa cảm biến vào Kafka
scripts/list_stress_windows.py Tìm các cửa sổ nhãn Stress/Non-Stress thuần để demo
scripts/compare_e4_pickle_window.py So sánh đặc trưng giữa pickle và E4 CSV
scripts/train_stress_model.py Huấn luyện Random Forest với đánh giá Leave-One-Subject-Out
scripts/edge_inference.py     Thiết bị Edge đọc Kafka, dự đoán cửa sổ 30s + vitals vào PostgreSQL
scripts/device_manager_api.py API điều khiển phiên phát & hợp nhất timeline Spark 10s + Edge 30s
app/                          Giao diện Next.js 2 tab (Theo dõi sức khỏe cá nhân & Vận hành MLOps)
sql/001_init.sql              Schema PostgreSQL (stress_predictions, sensor_window_aggregates, feedback)
compose.yaml                  Kafka, PostgreSQL, Grafana, Spark, Model Registry, Prometheus, cAdvisor
grafana/                      Provisioning datasource và dashboard giám sát hạ tầng Prometheus
docs/data-contract.md         Định dạng sự kiện wearable.sensor.v1 giữa các thành phần
```
