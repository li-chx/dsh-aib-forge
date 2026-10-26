/** Shared navigation into the Worker-owned management page through the actual application sidebar. */
export async function readyAiw(page, { chinese = false, fresh = false } = {}) {
  await page.getByRole('button', { name: 'dsh-aiw', exact: true }).waitFor()
  const welcome = page.getByRole('button', { name: chinese ? '继续' : 'Continue', exact: true })
  const setup = page.getByRole('dialog', { name: chinese ? '开始使用' : 'Get started', exact: true })
  if (fresh) await welcome.or(setup).first().waitFor({ state: 'visible' })
  if (await welcome.isVisible()) await welcome.click()
  if (fresh) await setup.waitFor({ state: 'visible' })
  if (await setup.isVisible()) {
    await setup.getByRole('button', { name: chinese ? '添加 API Key' : 'Add API Key', exact: true }).click()
    await page.getByRole('button', { name: chinese ? '稍后配置' : 'Configure later', exact: true }).click()
  }
}

/** Open the registered panel without replacing the page or touching application state outside navigation. */
export async function openAiw(page, options) {
  await readyAiw(page, options)
  await page.getByRole('button', { name: 'dsh-aiw', exact: true }).click()
  const panel = page.locator('[data-aiw-panel]')
  await panel.waitFor({ state: 'visible' })
  return panel
}
