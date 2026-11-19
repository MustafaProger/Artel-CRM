import { createContext, useContext, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import PageLoading from './PageLoading'

export const RoutePlaceholder = createContext<ReactNode>(<PageLoading/>)

/** Share downloaded code across visits. Each mounted page still reads its own authorized data. */
export function routeModule<Props extends object>(loader: () => Promise<{ default: ComponentType<Props> }>) {
  let ready: ComponentType<Props> | null = null
  let pending: Promise<ComponentType<Props>> | undefined
  const preload = () => {
    pending ??= loader().then(module => {
      ready = module.default
      return ready
    }).catch(error => { pending = undefined; throw error })
    return pending
  }
  function Page(props: Props) {
    const [Current, setCurrent] = useState<ComponentType<Props> | null>(() => ready)
    const [failure, setFailure] = useState<Error | null>(null)
    const placeholder = useContext(RoutePlaceholder)
    useEffect(() => {
      if (Current) return
      let mounted = true
      void preload().then(component => { if (mounted) setCurrent(() => component) })
        .catch(error => { if (mounted) setFailure(error) })
      return () => { mounted = false }
    }, [Current])
    if (failure) throw failure
    return Current ? <Current {...props}/> : <>{placeholder}</>
  }
  return { preload, Page }
}
