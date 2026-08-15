import React from 'react'

const Panel = ({children}: {children: React.ReactNode}) => {
  return (
    <div className="border rounded p-4 flex flex-col">
      {children}
    </div>
  )
}

export default Panel
