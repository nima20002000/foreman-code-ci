import { DEFAULT_MAINTENANCE_TASK_LIMIT, type ComputerMaintenanceList } from '@foreman-code/contracts/computer-maintenance'

/** Queued tasks use the running state until their predecessor finishes. */
export function maintenanceHistoryResult(
  result: ComputerMaintenanceList,
  input: { taskLimit?: number | undefined },
): ComputerMaintenanceList {
  const taskLimit = input.taskLimit ?? DEFAULT_MAINTENANCE_TASK_LIMIT
  return { computers: result.computers.map(computer => {
    if (!computer.status) return computer
    const status = computer.status
    const tasks = [...status.tasks]
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      .filter((task, index) => index < taskLimit || task.state === 'running')
    return { ...computer, tasksOmitted: computer.tasksOmitted + status.tasks.length - tasks.length,
      status: { ...status, tasks } }
  }) }
}
