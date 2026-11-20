FROM eclipse-temurin:21-jre-alpine

ARG JMX_EXPORTER_VERSION=1.7.0
RUN apk add --no-cache ca-certificates curl \
    && curl -fsSL "https://github.com/prometheus/jmx_exporter/releases/download/${JMX_EXPORTER_VERSION}/jmx_prometheus_standalone-${JMX_EXPORTER_VERSION}.jar" \
       -o /opt/jmx_prometheus_standalone.jar \
    && apk del curl

COPY kafka-jmx.yml /opt/kafka.yml

EXPOSE 9404
ENTRYPOINT ["java", "-jar", "/opt/jmx_prometheus_standalone.jar", "9404", "/opt/kafka.yml"]
