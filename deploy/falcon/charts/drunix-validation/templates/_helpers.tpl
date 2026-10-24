{{- define "drunix-validation.name" -}}
{{- default (printf "vs-%s" .Values.organisation.name) .Values.nameOverride -}}
{{- end -}}

{{- define "drunix-validation.labels" -}}
app.kubernetes.io/name: {{ include "drunix-validation.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: validation-service
app.kubernetes.io/part-of: {{ .Values.project }}
drunix.npci.org.in/role: vscc
drunix.npci.org.in/msp: {{ .Values.organisation.mspId }}
{{- end -}}
