export type NotionRecordFile = { path: string; name: string; size: number }

export type NotionRecords = {
  spaceId: string
  rootIds: string[]
  blocks: Record<string, any>
  collections: Record<string, any>
  views: Record<string, any>
  users: Record<string, any>
  rows: Record<string, string[]>
  files: Record<string, NotionRecordFile>
}
