import React from 'react'

const Panel = ({children}: {children: React.ReactNode}) => {
  return (
    <div className="border rounded p-4 flex flex-col min-w-0">
      {children}
    </div>
  )
}

export default Panel
