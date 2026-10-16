import assert from 'node:assert/strict'
import { createServer } from 'vite'

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
assert.equal(zone, 'Europe/Zurich', 'run with TZ=Europe/Zurich so the daylight-saving day is 25 hours')

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const {
    classifyHomeworkTask,
    createHomeworkTask,
    parseHomeworkMarkdown,
    sortHomeworkTasks,
    taskDueTimestamp,
  } = await server.ssrLoadModule('/src/lib/homeworkStore.ts')

  const task = (dueDate, dueTime, extra = {}) => ({
    id: 'task',
    title: 'Lesen',
    notes: '',
    subject: 'Deutsch',
    dueDate,
    dueTime,
    done: false,
    kind: 'homework',
    priority: 'normal',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  })

  const fallbackNoon = new Date(2026, 9, 25, 12, 0, 0)
  assert.equal(classifyHomeworkTask(task('2026-10-25', '23:30'), fallbackNoon), 'today')
  assert.equal(classifyHomeworkTask(task('2026-10-24', '23:30'), fallbackNoon), 'overdue')
  assert.equal(classifyHomeworkTask(task('2026-10-26', '00:30'), fallbackNoon), 'upcoming')

  const springNoon = new Date(2026, 2, 29, 12, 0, 0)
  assert.equal(classifyHomeworkTask(task('2026-03-30', '00:30'), springNoon), 'upcoming')
  assert.equal(classifyHomeworkTask(task('2026-03-29', '23:30'), springNoon), 'today')

  assert.equal(classifyHomeworkTask(task('2026-10-25', '08:00', { done: true }), fallbackNoon), 'done')
  assert.equal(classifyHomeworkTask(task(null, null), fallbackNoon), 'undated')

  const created = createHomeworkTask({ title: 'Probe', dueDate: '2026-02-31', dueTime: '24:00' })
  assert.equal(created.dueDate, null)
  assert.equal(created.dueTime, null)
  assert.equal(createHomeworkTask({ title: 'Probe', dueDate: '2026-02-28', dueTime: '00:00' }).dueTime, '00:00')

  const markdown = [
    '# Hausaufgaben',
    '',
    '<!-- fanotes-homework-v1',
    JSON.stringify({
      version: 1,
      tasks: [task('2026-02-31', '24:00', { id: 'bad', title: 'Unmöglich' })],
    }),
    '-->',
    '',
  ].join('\n')
  const parsed = parseHomeworkMarkdown(markdown)
  assert.equal(parsed.tasks[0].title, 'Unmöglich')
  assert.equal(parsed.tasks[0].dueDate, null)
  assert.equal(parsed.tasks[0].dueTime, null)
  assert.equal(taskDueTimestamp(parsed.tasks[0]), null)

  const late = task('2026-10-24', '18:00', { id: 'late' })
  const evening = task('2026-10-25', '23:30', { id: 'evening' })
  const next = task('2026-10-26', '08:00', { id: 'next' })
  assert.deepEqual(sortHomeworkTasks([next, evening, late]).map((item) => item.id), ['late', 'evening', 'next'])
  const eveningStamp = taskDueTimestamp(evening)
  const lateStamp = taskDueTimestamp(late)
  assert.ok(eveningStamp > lateStamp)
  assert.equal(new Date(eveningStamp).getDate(), 25)
  assert.equal(new Date(eveningStamp).getHours(), 23)

  console.log('homework-day ok')
} finally {
  await server.close()
}
