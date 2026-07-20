/**
 * Create-from-template dialog — a 3-step wizard that lets the user pick a
 * template, fill in its parameters, preview the generated source files, and
 * download them as a ZIP.
 *
 * Steps:
 *   1. Select  — pick one of the available templates (filtered by `kind`)
 *   2. Configure — fill in the template's parameter form
 *   3. Preview  — browse generated files, copy individual files, or
 *                 download the whole project as a .zip
 *
 * The dialog is self-contained: it fetches the template list on mount,
 * calls the scaffold API to generate, and manages its own step state. The
 * parent only needs to mount/unmount it and pass a `kind` filter.
 */
import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react'
import { Dialog } from '@ui/components/Dialog'
import { Button } from '@ui/components/Button'
import { Input, Textarea } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { Checkbox } from '@ui/components/Checkbox'
import {
  listCmsPluginTemplates,
  scaffoldCmsPlugin,
  scaffoldCmsPluginAsZip,
} from '@core/persistence'
import type {
  CmsPluginTemplateSummary,
  CmsPluginTemplateParam,
  CmsPluginScaffoldResult,
} from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { ArrowLeftIcon } from 'pixel-art-icons/icons/arrow-left'
import { ArrowRightIcon } from 'pixel-art-icons/icons/arrow-right'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { PackageSolidIcon } from 'pixel-art-icons/icons/package-solid'
import { SparklesSolidIcon } from 'pixel-art-icons/icons/sparkles-solid'
import styles from './CreateFromTemplateDialog.module.css'

type Step = 'select' | 'configure' | 'preview'

interface CreateFromTemplateDialogProps {
  /** Filter templates to only show this kind. */
  kind: 'plugin' | 'skill'
  onClose: () => void
}

export function CreateFromTemplateDialog({ kind, onClose }: CreateFromTemplateDialogProps) {
  const [step, setStep] = useState<Step>('select')
  const [templates, setTemplates] = useState<CmsPluginTemplateSummary[]>([])
  const [loadingTemplates, setLoadingTemplates] = useState(true)
  const [selectedTemplate, setSelectedTemplate] = useState<CmsPluginTemplateSummary | null>(null)
  const [paramValues, setParamValues] = useState<Record<string, unknown>>({})
  const [scaffoldResult, setScaffoldResult] = useState<CmsPluginScaffoldResult | null>(null)
  const [generating, setGenerating] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [copiedFile, setCopiedFile] = useState(false)

  // ---- load templates on mount ----
  useEffect(() => {
    let cancelled = false
    setLoadingTemplates(true)
    setError(null)
    listCmsPluginTemplates()
      .then((all) => {
        if (cancelled) return
        setTemplates(all.filter((t) => t.kind === kind))
      })
      .catch((err) => {
        if (cancelled) return
        setError(getErrorMessage(err, 'Failed to load templates'))
      })
      .finally(() => {
        if (!cancelled) setLoadingTemplates(false)
      })
    return () => {
      cancelled = true
    }
  }, [kind])

  // ---- reset params when template changes ----
  const selectTemplate = useCallback((tmpl: CmsPluginTemplateSummary) => {
    setSelectedTemplate(tmpl)
    // Seed defaults from the param spec
    const defaults: Record<string, unknown> = {}
    for (const p of tmpl.params) {
      if (p.default !== undefined) defaults[p.id] = p.default
    }
    setParamValues(defaults)
    setError(null)
  }, [])

  // ---- generate ----
  const handleGenerate = useCallback(async () => {
    if (!selectedTemplate) return
    setGenerating(true)
    setError(null)
    try {
      const result = await scaffoldCmsPlugin(selectedTemplate.id, paramValues)
      setScaffoldResult(result)
      const fileNames = Object.keys(result.files)
      setActiveFile(fileNames[0] ?? null)
      setStep('preview')
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to generate project'))
    } finally {
      setGenerating(false)
    }
  }, [selectedTemplate, paramValues])

  // ---- download zip ----
  const handleDownloadZip = useCallback(async () => {
    if (!selectedTemplate) return
    setDownloading(true)
    setError(null)
    try {
      const blob = await scaffoldCmsPluginAsZip(selectedTemplate.id, paramValues)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const pluginId = scaffoldResult?.manifest.id ?? selectedTemplate.id
      a.download = `${pluginId.replace(/\./g, '-')}.zip`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to download ZIP'))
    } finally {
      setDownloading(false)
    }
  }, [selectedTemplate, paramValues, scaffoldResult])

  // ---- copy file ----
  const handleCopyFile = useCallback(async () => {
    if (!activeFile || !scaffoldResult) return
    const content = scaffoldResult.files[activeFile]
    if (content === undefined) return
    try {
      await navigator.clipboard.writeText(content)
      setCopiedFile(true)
      setTimeout(() => setCopiedFile(false), 2000)
    } catch {
      // clipboard API may be unavailable in insecure contexts
    }
  }, [activeFile, scaffoldResult])

  // ---- validation: required params filled ----
  const canGenerate = useMemo(() => {
    if (!selectedTemplate) return false
    for (const p of selectedTemplate.params) {
      if (!p.required) continue
      const val = paramValues[p.id]
      if (val === undefined || val === '' || (Array.isArray(val) && val.length === 0)) {
        return false
      }
    }
    return true
  }, [selectedTemplate, paramValues])

  // ---- step indicator ----
  const steps: Array<{ label: string; key: Step }> = [
    { label: 'Template', key: 'select' },
    { label: 'Configure', key: 'configure' },
    { label: 'Preview', key: 'preview' },
  ]
  const currentStepIndex = steps.findIndex((s) => s.key === step)

  const stepIndicator = (
    <div className={styles.stepIndicator}>
      {steps.map((s, i) => (
        <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
          <span
            className={`${styles.stepDot} ${i === currentStepIndex ? styles.stepDotActive : ''} ${i < currentStepIndex ? styles.stepDotDone : ''}`}
          />
          <span>{s.label}</span>
          {i < steps.length - 1 && <span className={styles.stepSeparator} />}
        </div>
      ))}
    </div>
  )

  // ---- footer per step ----
  const footer: ReactNode = (() => {
    if (step === 'select') {
      return (
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!selectedTemplate}
            onClick={() => setStep('configure')}
          >
            <span>Next</span>
            <ArrowRightIcon size={14} aria-hidden="true" />
          </Button>
        </>
      )
    }
    if (step === 'configure') {
      return (
        <>
          <Button variant="secondary" size="sm" onClick={() => setStep('select')}>
            <ArrowLeftIcon size={14} aria-hidden="true" />
            <span>Back</span>
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canGenerate || generating}
            onClick={() => void handleGenerate()}
          >
            <span>{generating ? 'Generating…' : 'Generate'}</span>
            {!generating && <SparklesSolidIcon size={14} aria-hidden="true" />}
          </Button>
        </>
      )
    }
    // preview
    return (
      <>
        <Button variant="secondary" size="sm" onClick={() => setStep('configure')}>
          <ArrowLeftIcon size={14} aria-hidden="true" />
          <span>Back</span>
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={downloading}
          onClick={() => void handleDownloadZip()}
        >
          <PackageSolidIcon size={14} aria-hidden="true" />
          <span>{downloading ? 'Downloading…' : 'Download ZIP'}</span>
        </Button>
      </>
    )
  })()

  const dialogSize = step === 'preview' ? '2xl' : 'lg'
  const title = kind === 'skill' ? 'Create Skill from Template' : 'Create Plugin from Template'

  return (
    <Dialog
      open
      onClose={generating || downloading ? () => {} : onClose}
      title={title}
      eyebrow="Scaffold"
      size={dialogSize}
      footer={footer}
    >
      {stepIndicator}

      {error && (
        <p className={styles.formError} role="alert" style={{ marginBottom: 'var(--space-m)' }}>
          {error}
        </p>
      )}

      {/* ---- Step 1: Select template ---- */}
      {step === 'select' && (
        <>
          {loadingTemplates ? (
            <div className={styles.loadingState}>Loading templates…</div>
          ) : templates.length === 0 ? (
            <div className={styles.loadingState}>No templates available.</div>
          ) : (
            <div className={styles.templateGrid}>
              {templates.map((tmpl) => (
                <button
                  key={tmpl.id}
                  type="button"
                  className={`${styles.templateCard} ${selectedTemplate?.id === tmpl.id ? styles.templateCardSelected : ''}`}
                  onClick={() => selectTemplate(tmpl)}
                >
                  <span className={styles.templateCardLabel}>{tmpl.label}</span>
                  <span className={styles.templateCardDesc}>{tmpl.description}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* ---- Step 2: Configure ---- */}
      {step === 'configure' && selectedTemplate && (
        <div className={styles.form}>
          {selectedTemplate.params.map((param) => (
            <ParamField
              key={param.id}
              param={param}
              value={paramValues[param.id]}
              onChange={(val) => setParamValues((prev) => ({ ...prev, [param.id]: val }))}
            />
          ))}
        </div>
      )}

      {/* ---- Step 3: Preview ---- */}
      {step === 'preview' && scaffoldResult && (
        <>
          <div className={styles.previewLayout}>
            <div className={styles.fileList}>
              {Object.keys(scaffoldResult.files).map((path) => (
                <button
                  key={path}
                  type="button"
                  className={`${styles.fileItem} ${activeFile === path ? styles.fileItemActive : ''}`}
                  onClick={() => setActiveFile(path)}
                  title={path}
                >
                  <span>{path}</span>
                </button>
              ))}
            </div>
            <pre className={styles.fileContent}>
              {activeFile ? scaffoldResult.files[activeFile] : ''}
            </pre>
          </div>

          {activeFile && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-s)' }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleCopyFile()}
              >
                {copiedFile ? (
                  <>
                    <CheckIcon size={14} aria-hidden="true" />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <CopySolidIcon size={14} aria-hidden="true" />
                    <span>Copy file</span>
                  </>
                )}
              </Button>
            </div>
          )}

          {scaffoldResult.warnings.length > 0 && (
            <div className={styles.warnings}>
              {scaffoldResult.warnings.map((w, i) => (
                <span key={i}>{w}</span>
              ))}
            </div>
          )}
        </>
      )}
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// ParamField — renders the right input control for a template parameter
// ---------------------------------------------------------------------------

interface ParamFieldProps {
  param: CmsPluginTemplateParam
  value: unknown
  onChange: (value: unknown) => void
}

function ParamField({ param, value, onChange }: ParamFieldProps) {
  const label = (
    <>
      {param.label}
      {param.required && <span style={{ color: 'var(--danger)' }}>*</span>}
    </>
  )

  return (
    <div className={styles.formRow}>
      <label className={styles.formLabel} htmlFor={`tpl-${param.id}`}>
        {label}
      </label>
      {param.description && <span className={styles.formHint}>{param.description}</span>}
      {renderControl(param, value, onChange)}
    </div>
  )
}

function renderControl(
  param: CmsPluginTemplateParam,
  value: unknown,
  onChange: (value: unknown) => void,
): ReactNode {
  const inputId = `tpl-${param.id}`

  switch (param.type) {
    case 'textarea':
      return (
        <Textarea
          id={inputId}
          fieldSize="sm"
          value={typeof value === 'string' ? value : ''}
          placeholder={param.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )

    case 'boolean':
      return (
        <label htmlFor={inputId} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-s)', cursor: 'pointer' }}>
          <Checkbox
            id={inputId}
            checked={value === true}
            onCheckedChange={(checked) => onChange(checked)}
          />
          <span className={styles.formHint}>{param.placeholder ?? 'Enable'}</span>
        </label>
      )

    case 'select':
      return (
        <Select
          fieldSize="sm"
          value={typeof value === 'string' ? value : ''}
          placeholder={param.placeholder}
          options={param.options?.map((o) => ({ value: o.value, label: o.label })) ?? []}
          onChange={(e) => onChange(e.target.value)}
        />
      )

    case 'string[]':
      return (
        <Textarea
          id={inputId}
          fieldSize="sm"
          value={Array.isArray(value) ? value.join('\n') : ''}
          placeholder={param.placeholder ?? 'One item per line'}
          onChange={(e) =>
            onChange(
              e.target.value
                .split('\n')
                .map((s) => s.trim())
                .filter((s) => s.length > 0),
            )
          }
        />
      )

    default:
      return (
        <Input
          id={inputId}
          fieldSize="sm"
          value={typeof value === 'string' ? value : ''}
          placeholder={param.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )
  }
}
